#!/usr/bin/env python3
"""The converter: takes the songs uploaded on the site, runs song2cho on them here, and hands the results back.

usage: GB_CONVERTER_TOKEN=<token> python3 tools/song2cho/converter.py [--url URL] [--once] [--interval S] [--keep]

It asks the site for the oldest waiting song (worker/converter.ts), downloads its recording, runs song2cho.sh
on it, uploads the band-only and the drums & bass tracks and the ChordPro text (timing included), and asks again.
While it is not running, uploaded songs wait. A song that fails is marked failed on the site, with the reason;
the full output of song2cho is kept in tools/song2cho/work/queue/job-<id>.log.

  GB_CONVERTER_TOKEN   the site's CONVERTER_TOKEN secret (required; never on the command line)
  --url URL            the site (default: GB_URL, else https://www.gb-songs.com); the local one is
                       http://127.0.0.1:8791, whose token is in compose.yaml
  --once               convert what is waiting, then stop
  --interval S         seconds between two looks when nothing is waiting (default 15)
  --keep               keep each song's intermediate files (tools/song2cho/work/job-<id>/, several hundred MB)

Needs song2cho's own environment (tools/song2cho/.venv); this script itself uses only the standard library.
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, time, urllib.error, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
QUEUE = HERE / "work" / "queue"
TIMEOUT_S = 25 * 60   # the site hands a song out again after 30 minutes
EXTENSIONS = {".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac"}


class Gone(Exception):
    """The song was deleted, or handed to another converter, while this one worked on it."""


def log(*words):
    print(time.strftime("%H:%M:%S"), *words, flush=True)


class Site:
    def __init__(self, url, token):
        self.url, self.token = url.rstrip("/"), token

    def call(self, method, path, body=None, content_type=None, to=None):
        """One request to /api/converter/<path>. body: bytes, or anything else as JSON. to: a path to save the
        reply in; otherwise the reply is parsed as JSON."""
        headers = {"Authorization": f"Bearer {self.token}", "User-Agent": "gb-converter"}
        if body is not None and not isinstance(body, bytes):
            body, content_type = json.dumps(body).encode(), "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(f"{self.url}/api/converter/{path}", data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=300) as reply:
                if to is None:
                    return json.load(reply)
                with open(to, "wb") as out:
                    shutil.copyfileobj(reply, out)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise Gone() from None
            detail = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {detail}") from None


def convert(site, job, keep):
    """One job: {id, title, file_name}. Returns nothing; raises Gone, or anything else when the site fails."""
    song, name = job["id"], f"job-{job['id']}"
    ext = pathlib.Path(job["file_name"]).suffix.lower()
    src = QUEUE / (name + (ext if ext in EXTENSIONS else ".mp3"))
    out = QUEUE / f"{name}.out"
    work = HERE / "work" / name
    logfile = QUEUE / f"{name}.log"
    QUEUE.mkdir(parents=True, exist_ok=True)
    try:
        site.call("GET", f"source/{song}", to=src)
        log(f"song {song} ({job['title']}): converting, output in {logfile}")
        env = {**os.environ, "SONG2CHO_OUT": str(out), "SONG2CHO_TITLE": job["title"]}
        failure = ""
        with open(logfile, "w") as lf:
            try:
                done = subprocess.run(["zsh", str(HERE / "song2cho.sh"), str(src)], env=env, stdout=lf,
                                      stderr=subprocess.STDOUT, timeout=TIMEOUT_S)
                if done.returncode:
                    failure = "The recording could not be converted."
            except subprocess.TimeoutExpired:
                failure = "The conversion took too long and was stopped."
        cho = out / f"{name}.cho"
        if not failure and not cho.exists():
            failure = "The conversion made no song."
        if failure:
            lines = [l.strip() for l in logfile.read_text(errors="replace").splitlines() if l.strip()]
            log(f"song {song}: failed; last output: {lines[-1] if lines else '(none)'}")
            site.call("POST", f"fail/{song}", {"error": failure})
            return
        for track in ("instrumental", "rhythm"):
            mp3 = out / f"{name}.{track}.mp3"
            if mp3.exists():
                site.call("PUT", f"track/{song}/{track}", mp3.read_bytes(), "audio/mpeg")
        # The {x_audio: …} lines name this machine's files; on the site the tracks are the song's own.
        text = "\n".join(l for l in cho.read_text(encoding="utf-8").split("\n")
                         if not l.startswith(("{x_audio:", "{x_instrumental:", "{x_rhythm:")))
        # The text holds the timing ({x_bars}, {x_line}, {x_end}); nothing is sent apart from it.
        site.call("POST", f"done/{song}", {"cho": text, "sync": None})
        logfile.unlink()
        log(f"song {song}: ready")
    finally:
        src.unlink(missing_ok=True)
        shutil.rmtree(out, ignore_errors=True)
        if not keep:
            shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("GB_URL", "https://www.gb-songs.com"))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=float, default=15)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    token = os.environ.get("GB_CONVERTER_TOKEN", "")
    if not token:
        sys.exit("GB_CONVERTER_TOKEN is not set (the site's CONVERTER_TOKEN secret)")
    if not (HERE / ".venv" / "bin" / "python").exists():
        sys.exit(f"song2cho's environment is missing: {HERE / '.venv'}")
    site = Site(a.url, token)
    log(f"converter for {site.url}; Ctrl-C to stop")
    while True:
        job = None
        try:
            job = site.call("POST", "claim")["job"]
            if job:
                convert(site, job, a.keep)
        except Gone:
            log(f"song {job['id'] if job else '?'}: gone from the site, skipped")
        except KeyboardInterrupt:
            log("stopped" + (f"; song {job['id']} stays 'converting' on the site for up to 30 minutes" if job else ""))
            return
        except Exception as e:   # the site or the network: try again later
            log(f"error: {e}")
            if a.once:
                sys.exit(1)
            time.sleep(a.interval)
            continue
        if not job:
            if a.once:
                return
            try:
                time.sleep(a.interval)
            except KeyboardInterrupt:
                log("stopped")
                return


if __name__ == "__main__":
    main()
