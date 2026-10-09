"""One-shot Windows GDI fallback; output is a PNG, never a filesystem path."""
import json
import sys
import mss
import mss.tools

region = json.loads(sys.argv[1])
if set(region) != {"left", "top", "width", "height"} or not all(isinstance(v, int) for v in region.values()):
    raise ValueError("Invalid capture region")
if not 0 < region["width"] * region["height"] <= 80_000_000:
    raise ValueError("Invalid capture dimensions")
with mss.mss() as capture:
    shot = capture.grab(region)
    sys.stdout.buffer.write(mss.tools.to_png(shot.rgb, shot.size))
