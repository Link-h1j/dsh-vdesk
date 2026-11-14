import sys, os
import cv2

src = sys.argv[1]
outdir = sys.argv[2]
max_frames = int(sys.argv[3]) if len(sys.argv) > 3 else 12
os.makedirs(outdir, exist_ok=True)

cap = cv2.VideoCapture(src)
if not cap.isOpened():
    print("OPEN FAILED")
    sys.exit(1)

n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
fps = cap.get(cv2.CAP_PROP_FPS) or 0
w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
print("frames=%d fps=%.2f size=%dx%d dur=%.1fs" % (n, fps, w, h, (n / fps) if fps else 0))

if n <= 0:
    # some webm have unknown frame count: read sequentially
    idx = 0
    saved = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % 30 == 0 and saved < max_frames:
            p = os.path.join(outdir, "f%03d.jpg" % idx)
            cv2.imwrite(p, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            saved += 1
        idx += 1
    print("sequential saved=%d total=%d" % (saved, idx))
else:
    step = max(1, n // max_frames)
    saved = 0
    for i in range(0, n, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            continue
        p = os.path.join(outdir, "f%04d.jpg" % i)
        cv2.imwrite(p, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        saved += 1
        if saved >= max_frames:
            break
    print("saved=%d -> %s" % (saved, outdir))
cap.release()
