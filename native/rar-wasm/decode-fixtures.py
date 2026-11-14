from pathlib import Path
import binascii

ROOT = Path("/vercel/sandbox/libarchive/libarchive/test")
OUT = Path("/vercel/sandbox/fixtures")
OUT.mkdir(exist_ok=True)

FIXTURES = {
    "rar4.rar": "test_read_format_rar_binary_data.rar.uu",
    "rar5.rar": "test_read_format_rar5_compressed.rar.uu",
    "rar4-encrypted.rar": "test_read_format_rar4_encrypted.rar.uu",
    "rar5-encrypted.rar": "test_read_format_rar5_encrypted.rar.uu",
}

for output_name, source_name in FIXTURES.items():
    lines = (ROOT / source_name).read_bytes().splitlines()
    payload = bytearray()
    for line in lines[1:]:
        if line in (b"`", b"end"):
            continue
        payload.extend(binascii.a2b_uu(line))
    (OUT / output_name).write_bytes(payload)
    print(output_name, len(payload))
