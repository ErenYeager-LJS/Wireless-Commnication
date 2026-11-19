"""Install the pinned OpenCV Zoo YOLOX model; downloads stay on E/project."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from receiver.person_detection import MODEL_PATH, MODEL_SHA256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mirror', action='store_true', help='use hf-mirror.com')
    args = parser.parse_args()
    if MODEL_PATH.is_file() and hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() == MODEL_SHA256:
        print('Person model already installed and SHA-256 verified.')
        return
    host = 'hf-mirror.com' if args.mirror else 'huggingface.co'
    revision = '78c368f74ce73ee28fc7a1be418a598c71b58b52'
    url = f'https://{host}/opencv/object_detection_yolox/resolve/{revision}/object_detection_yolox_2022nov.onnx'
    scratch = ROOT / 'Soft/buffer/temp/person-yolox.onnx.part'
    scratch.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(['curl.exe' if sys.platform == 'win32' else 'curl',
                        '-f', '-L', '--proto', '=https', '--retry', '2',
                        '--connect-timeout', '10', '--max-time', '180',
                        '-o', str(scratch), url], check=True)
        if hashlib.sha256(scratch.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError('Downloaded model SHA-256 mismatch; not installed')
        MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(scratch), str(MODEL_PATH))
        print('Person model installed; SHA-256 verified.')
    finally:
        scratch.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
