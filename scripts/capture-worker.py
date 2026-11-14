"""One-shot Windows GDI fallback; output is a PNG, never a filesystem path."""

import ctypes
import json
import sys

import mss
import mss.tools


DESKTOP_READOBJECTS = 0x0001
UOI_NAME = 2
DESKTOP_UNAVAILABLE_MARKER = "OPENCAPTURE_CAPTURE_DESKTOP_UNAVAILABLE "


def _win32_desktop_api():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = ctypes.c_void_p
    dword = ctypes.c_ulong
    bool_type = ctypes.c_int

    kernel32.GetCurrentThreadId.argtypes = []
    kernel32.GetCurrentThreadId.restype = dword
    user32.GetThreadDesktop.argtypes = [dword]
    user32.GetThreadDesktop.restype = handle
    user32.OpenInputDesktop.argtypes = [dword, bool_type, dword]
    user32.OpenInputDesktop.restype = handle
    user32.GetUserObjectInformationW.argtypes = [
        handle,
        ctypes.c_int,
        ctypes.c_void_p,
        dword,
        ctypes.POINTER(dword),
    ]
    user32.GetUserObjectInformationW.restype = bool_type
    user32.CloseDesktop.argtypes = [handle]
    user32.CloseDesktop.restype = bool_type
    return user32, kernel32


def _desktop_name(user32, handle):
    if not handle:
        return None
    needed = ctypes.c_ulong()
    ctypes.set_last_error(0)
    user32.GetUserObjectInformationW(
        handle, UOI_NAME, None, 0, ctypes.byref(needed)
    )
    if needed.value == 0:
        return None
    buffer = ctypes.create_unicode_buffer(needed.value // ctypes.sizeof(ctypes.c_wchar))
    ctypes.set_last_error(0)
    if not user32.GetUserObjectInformationW(
        handle,
        UOI_NAME,
        buffer,
        needed.value,
        ctypes.byref(needed),
    ):
        return None
    return buffer.value


def desktop_access_state():
    user32, kernel32 = _win32_desktop_api()
    thread_handle = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
    thread_name = _desktop_name(user32, thread_handle)
    ctypes.set_last_error(0)
    input_handle = user32.OpenInputDesktop(0, False, DESKTOP_READOBJECTS)
    input_error = ctypes.get_last_error() if not input_handle else 0
    try:
        input_name = _desktop_name(user32, input_handle)
        if input_handle and input_name is None:
            input_error = ctypes.get_last_error()
    finally:
        if input_handle:
            user32.CloseDesktop(input_handle)
    return {
        "threadDesktop": thread_name,
        "inputDesktop": input_name,
        "inputError": input_error,
    }


def desktop_access_error(state):
    if state.get("inputError"):
        return {
            "reason": "input-desktop-denied",
            "inputError": state["inputError"],
        }
    thread_name = state.get("threadDesktop")
    input_name = state.get("inputDesktop")
    if not thread_name or not input_name:
        return {
            "reason": "desktop-name-unavailable",
            "threadDesktop": thread_name,
            "inputDesktop": input_name,
        }
    if thread_name.casefold() != input_name.casefold():
        return {
            "reason": "desktop-mismatch",
            "threadDesktop": thread_name,
            "inputDesktop": input_name,
        }
    return None


def run(region, state=None, capture_factory=mss.mss):
    error = desktop_access_error(state or desktop_access_state())
    if error:
        print(
            DESKTOP_UNAVAILABLE_MARKER + json.dumps(error, separators=(",", ":")),
            file=sys.stderr,
            flush=True,
        )
        return 3
    with capture_factory() as capture:
        shot = capture.grab(region)
        sys.stdout.buffer.write(mss.tools.to_png(shot.rgb, shot.size))
    return 0


def main():
    region = json.loads(sys.argv[1])
    if set(region) != {"left", "top", "width", "height"} or not all(
        isinstance(value, int) for value in region.values()
    ):
        raise ValueError("Invalid capture region")
    if not 0 < region["width"] * region["height"] <= 80_000_000:
        raise ValueError("Invalid capture dimensions")
    raise SystemExit(run(region))


if __name__ == "__main__":
    main()
