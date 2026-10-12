import ctypes
import json
import struct
import sys
import time

CF_HDROP = 15
GMEM_MOVEABLE = 0x0002

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)

user32.OpenClipboard.argtypes = [ctypes.c_void_p]
user32.OpenClipboard.restype = ctypes.c_bool
user32.CloseClipboard.argtypes = []
user32.CloseClipboard.restype = ctypes.c_bool
user32.EmptyClipboard.argtypes = []
user32.EmptyClipboard.restype = ctypes.c_bool
user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
user32.SetClipboardData.restype = ctypes.c_void_p
user32.GetClipboardData.argtypes = [ctypes.c_uint]
user32.GetClipboardData.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
kernel32.GlobalFree.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.restype = ctypes.c_bool
shell32.DragQueryFileW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_uint]
shell32.DragQueryFileW.restype = ctypes.c_uint


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return 1


def open_clipboard(hwnd):
    for delay in (0.01, 0.02, 0.04, 0.08, 0.16, 0.25):
        if user32.OpenClipboard(ctypes.c_void_p(hwnd)):
            return True
        time.sleep(delay)
    return False


def main():
    try:
        request = json.load(sys.stdin)
        hwnd = int(request["hwnd"])
        files = request["files"]
        if hwnd <= 0 or not isinstance(files, list) or not files:
            return fail("Invalid owner window or file list.")
        names = ("\0".join(files) + "\0\0").encode("utf-16le")
        payload = struct.pack("<IiiII", 20, 0, 0, 0, 1) + names
        memory = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(payload))
        if not memory:
            return fail("GlobalAlloc failed.")
        pointer = kernel32.GlobalLock(memory)
        if not pointer:
            kernel32.GlobalFree(memory)
            return fail("GlobalLock failed.")
        ctypes.memmove(pointer, payload, len(payload))
        kernel32.GlobalUnlock(memory)
        if not open_clipboard(hwnd):
            kernel32.GlobalFree(memory)
            return fail("Clipboard is busy.")
        transferred = False
        try:
            if not user32.EmptyClipboard():
                return fail("EmptyClipboard failed.")
            if not user32.SetClipboardData(CF_HDROP, memory):
                return fail("SetClipboardData failed.")
            transferred = True
            handle = user32.GetClipboardData(CF_HDROP)
            count = shell32.DragQueryFileW(handle, 0xFFFFFFFF, None, 0) if handle else 0
            if count != len(files):
                return fail("Clipboard readback validation failed.")
        finally:
            user32.CloseClipboard()
            if not transferred:
                kernel32.GlobalFree(memory)
        print(json.dumps({"ok": True, "count": len(files)}))
        return 0
    except Exception as error:
        return fail(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
