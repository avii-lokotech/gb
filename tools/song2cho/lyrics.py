import json, sys, mlx_whisper, imageio_ffmpeg, os, shutil
# mlx_whisper calls `ffmpeg` on PATH; point it at the bundled binary
d = os.path.join(os.path.dirname(sys.argv[2]), "bin"); os.makedirs(d, exist_ok=True)
link = os.path.join(d, "ffmpeg")
if not os.path.exists(link): os.symlink(imageio_ffmpeg.get_ffmpeg_exe(), link)
os.environ["PATH"] = d + ":" + os.environ["PATH"]
r = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                           word_timestamps=True, language="en", condition_on_previous_text=False)
words = [{"w": w["word"], "s": w["start"], "e": w["end"], "p": w.get("probability")}
         for seg in r["segments"] for w in seg.get("words", [])]
segs = [{"s": s["start"], "e": s["end"], "t": s["text"]} for s in r["segments"]]
json.dump({"segments": segs, "words": words}, open(sys.argv[2], "w"), indent=1)
print("segments", len(segs), "words", len(words))
