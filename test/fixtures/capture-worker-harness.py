import importlib.util
import io
import json
import sys
import types


worker_path = sys.argv[1]
fake_mss = types.ModuleType("mss")
fake_mss_tools = types.ModuleType("mss.tools")
fake_mss.mss = lambda: None
fake_mss_tools.to_png = lambda _rgb, _size: b""
fake_mss.tools = fake_mss_tools
sys.modules["mss"] = fake_mss
sys.modules["mss.tools"] = fake_mss_tools
spec = importlib.util.spec_from_file_location("capture_worker", worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BinaryText:
    def __init__(self):
        self.buffer = io.BytesIO()

    def write(self, value):
        return len(value)

    def flush(self):
        return None


class FakeShot:
    rgb = bytes(12)
    size = (2, 2)


class FakeCapture:
    def __init__(self):
        self.grabbed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def grab(self, _region):
        self.grabbed = True
        return FakeShot()


region = {"left": 0, "top": 0, "width": 2, "height": 2}
original_stdout = sys.stdout
original_to_png = worker.mss.tools.to_png
capture = FakeCapture()
same_output = BinaryText()
try:
    worker.mss.tools.to_png = lambda rgb, size: b"BLACK_FRAME_OK"
    sys.stdout = same_output
    same_code = worker.run(
        region,
        state={
            "threadDesktop": "Default",
            "inputDesktop": "default",
            "inputError": 0,
        },
        capture_factory=lambda: capture,
    )
finally:
    sys.stdout = original_stdout
    worker.mss.tools.to_png = original_to_png

mismatch_stdout = BinaryText()
mismatch_stderr = io.StringIO()
try:
    sys.stdout = mismatch_stdout
    sys.stderr = mismatch_stderr
    mismatch_code = worker.run(
        region,
        state={
            "threadDesktop": "Default",
            "inputDesktop": "Screen-saver",
            "inputError": 0,
        },
        capture_factory=lambda: (_ for _ in ()).throw(
            AssertionError("capture must not run")
        ),
    )
finally:
    sys.stdout = original_stdout
    sys.stderr = sys.__stderr__

print(
    json.dumps(
        {
            "sameDesktop": {
                "code": same_code,
                "captured": capture.grabbed,
                "output": same_output.buffer.getvalue().decode("ascii"),
            },
            "mismatch": {
                "code": mismatch_code,
                "stdoutBytes": len(mismatch_stdout.buffer.getvalue()),
                "stderr": mismatch_stderr.getvalue(),
            },
            "denied": worker.desktop_access_error(
                {
                    "threadDesktop": "Default",
                    "inputDesktop": None,
                    "inputError": 5,
                }
            ),
        }
    )
)
