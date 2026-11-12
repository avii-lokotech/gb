#!/bin/zsh
# song2cho — draft a ChordPro file (chords, timing grids, lyrics) from an audio file.
#
# usage: tools/song2cho/song2cho.sh path/to/song.mp3 [extra build.py options]
#   e.g. --capo 0          force no capo (default: auto, picks easiest shapes)
#        --keep-passing    keep 1-beat passing chords on beat 4
#        --title "..." --artist "..."   override ID3 tags
#
# Output: songs/<name>.cho   (intermediate files in tools/song2cho/work/<name>/)
# Environment (set by converter.py): SONG2CHO_OUT, the output folder instead of songs/;
#   SONG2CHO_TITLE, the title when the file has no ID3 title, instead of its name.
set -e
HERE=${0:A:h}
ROOT=${HERE:h:h}
PY=$HERE/.venv/bin/python
SRC=${1:A}; shift
NAME=${SRC:t:r}
W=$HERE/work/$NAME
OUT=${SONG2CHO_OUT:-$ROOT/songs}
mkdir -p $W $OUT
FF=$($PY -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")

[[ -f $W/$NAME.wav ]] || $FF -v error -y -i $SRC -ar 44100 -ac 2 $W/$NAME.wav
[[ -f $W/sep/htdemucs/$NAME/vocals.wav ]] || $PY -m demucs --two-stems=vocals -d mps -o $W/sep $W/$NAME.wav
[[ -f $W/beats.json ]]  || $PY $HERE/beats.py  $W/$NAME.wav $W/beats.json
[[ -f $W/chords.json ]] || $PY $HERE/chords.py $W/sep/htdemucs/$NAME/no_vocals.wav $W/beats.json $W/chords.json
[[ -f $W/lyrics.json ]] || $PY $HERE/lyrics.py $W/sep/htdemucs/$NAME/vocals.wav $W/lyrics.json

# title/artist from ID3 tags ("Artist - Title" style titles are split)
TAGS=$($FF -v error -i $SRC -f ffmetadata - 2>/dev/null || true)
ARTIST=$(print -r -- $TAGS | sed -n 's/^artist=//p' | head -1)
TITLE=$(print -r -- $TAGS | sed -n 's/^title=//p' | head -1)
[[ -n $ARTIST && $TITLE == "$ARTIST - "* ]] && TITLE=${TITLE#"$ARTIST - "}
[[ -z $TITLE ]] && TITLE=${SONG2CHO_TITLE:-$NAME}

REL=$($PY -c "import os,sys;print(os.path.relpath(sys.argv[1], sys.argv[2]))" $SRC $OUT)
# band-only track for the player's "Vocals off" button
INST=$OUT/$NAME.instrumental.mp3
[[ -f $INST ]] || $FF -v error -y -i $W/sep/htdemucs/$NAME/no_vocals.wav -codec:a libmp3lame -b:a 160k $INST
# drums + bass only, for the player's "Drums & bass" button (4-track split: drums, bass, other, vocals)
RHY=$OUT/$NAME.rhythm.mp3
S4=$W/sep4/htdemucs/$NAME
[[ -f $S4/drums.wav ]] || $PY -m demucs -d mps -o $W/sep4 $W/$NAME.wav
[[ -f $RHY ]] || $FF -v error -y -i $S4/drums.wav -i $S4/bass.wav \
  -filter_complex "amix=inputs=2:normalize=0:duration=longest" -codec:a libmp3lame -b:a 160k $RHY

$PY $HERE/build.py $W $OUT/$NAME.cho --title "$TITLE" --artist "$ARTIST" --audio "$REL" \
  --instrumental "${INST:t}" --rhythm "${RHY:t}" "$@"
