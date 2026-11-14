#include <archive.h>
#include <archive_entry.h>
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define OC_MAX_INPUT (100u * 1024u * 1024u)
#define OC_MAX_OUTPUT (256u * 1024u * 1024u)
#define OC_MAX_ENTRIES 5000
#define OC_MAX_CHUNK (1024u * 1024u)

static struct archive *reader = NULL;
static struct archive_entry *entry = NULL;
static const char *entry_path = NULL;
static int entry_type = 0;
static int entry_count = 0;
static int64_t entry_size = 0;
static uint64_t entry_read = 0;
static uint64_t declared_total = 0;
static uint64_t actual_total = 0;
static char error_message[512];

static void set_error(const char *message) {
    if (!message) message = "Unknown libarchive error";
    snprintf(error_message, sizeof(error_message), "%s", message);
}

static void set_archive_error(void) {
    set_error(reader ? archive_error_string(reader) : "RAR reader is closed");
}

EMSCRIPTEN_KEEPALIVE void oc_close(void) {
    if (reader) archive_read_free(reader);
    reader = NULL;
    entry = NULL;
    entry_path = NULL;
    entry_type = 0;
    entry_count = 0;
    entry_size = 0;
    entry_read = 0;
    declared_total = 0;
    actual_total = 0;
}

EMSCRIPTEN_KEEPALIVE int oc_open(const uint8_t *data, uint32_t size) {
    oc_close();
    error_message[0] = '\0';
    if (!data || size == 0 || size > OC_MAX_INPUT) {
        set_error("RAR input must be between 1 byte and 100 MiB");
        return 0;
    }
    reader = archive_read_new();
    if (!reader) {
        set_error("Could not allocate libarchive reader");
        return 0;
    }
    if (archive_read_support_format_rar(reader) != ARCHIVE_OK ||
        archive_read_support_format_rar5(reader) != ARCHIVE_OK) {
        set_archive_error();
        oc_close();
        return 0;
    }
    if (archive_read_open_memory(reader, data, size) != ARCHIVE_OK) {
        set_archive_error();
        oc_close();
        return 0;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE int oc_next(void) {
    if (!reader) {
        set_error("RAR reader is closed");
        return -1;
    }
    if (entry && entry_type == 1 && entry_read != (uint64_t)entry_size) {
        if (archive_read_data_skip(reader) != ARCHIVE_OK) {
            set_archive_error();
            return -1;
        }
    }
    int status = archive_read_next_header(reader, &entry);
    if (status == ARCHIVE_EOF) return 0;
    if (status != ARCHIVE_OK) {
        set_archive_error();
        return -1;
    }
    if (++entry_count > OC_MAX_ENTRIES) {
        set_error("RAR contains more than 5000 entries");
        return -1;
    }
    if (archive_entry_is_encrypted(entry) == 1 ||
        archive_read_has_encrypted_entries(reader) == 1) {
        set_error("Encrypted RAR archives are unavailable");
        return -1;
    }
    const char *symlink = archive_entry_symlink(entry);
    const char *hardlink = archive_entry_hardlink(entry);
    if ((symlink && symlink[0]) || (hardlink && hardlink[0])) {
        snprintf(error_message, sizeof(error_message),
                 "RAR links are unavailable: symlink=%s hardlink=%s",
                 symlink ? symlink : "", hardlink ? hardlink : "");
        return -1;
    }
    entry_path = archive_entry_pathname_utf8(entry);
    if (!entry_path || !entry_path[0]) {
        set_error("RAR entry path is missing or is not valid UTF-8");
        return -1;
    }
    mode_t file_type = archive_entry_filetype(entry);
    if (file_type == AE_IFDIR) {
        entry_type = 2;
        entry_size = 0;
    } else if (file_type == AE_IFREG) {
        if (!archive_entry_size_is_set(entry)) {
            set_error("RAR entry size is unavailable");
            return -1;
        }
        entry_type = 1;
        entry_size = archive_entry_size(entry);
        if (entry_size < 0 || (uint64_t)entry_size > OC_MAX_OUTPUT ||
            declared_total + (uint64_t)entry_size > OC_MAX_OUTPUT) {
            set_error("RAR expanded size exceeds 256 MiB");
            return -1;
        }
        declared_total += (uint64_t)entry_size;
    } else {
        set_error("RAR special files are unavailable");
        return -1;
    }
    entry_read = 0;
    return 1;
}

EMSCRIPTEN_KEEPALIVE const char *oc_path(void) { return entry_path; }
EMSCRIPTEN_KEEPALIVE int64_t oc_size(void) { return entry_size; }
EMSCRIPTEN_KEEPALIVE int oc_type(void) { return entry_type; }

EMSCRIPTEN_KEEPALIVE int oc_read(uint8_t *buffer, uint32_t capacity) {
    if (!reader || !entry || entry_type != 1 || !buffer || capacity == 0 ||
        capacity > OC_MAX_CHUNK) {
        set_error("Invalid RAR read request");
        return -1;
    }
    la_ssize_t count = archive_read_data(reader, buffer, capacity);
    if (count < 0) {
        set_archive_error();
        return -1;
    }
    if (count == 0) {
        if (entry_read != (uint64_t)entry_size) {
            set_error("RAR entry ended before its declared size");
            return -1;
        }
        return 0;
    }
    entry_read += (uint64_t)count;
    actual_total += (uint64_t)count;
    if (entry_read > (uint64_t)entry_size || actual_total > OC_MAX_OUTPUT) {
        set_error("RAR decoder exceeded its bounded output size");
        return -1;
    }
    return (int)count;
}

EMSCRIPTEN_KEEPALIVE const char *oc_error(void) { return error_message; }
