#!/bin/bash
if [ -z "$1" ]; then
  echo "Usage: ./run.sh <path_to_video>"
  exit 1
fi
python3 detect.py "$1"
