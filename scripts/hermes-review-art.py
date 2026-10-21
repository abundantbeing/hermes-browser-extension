#!/usr/bin/env python
"""Generate one on-brand illustration for an HBE pull-request or issue review.

JSON in, JSON out. Never raises for a provider or hosting failure: the review
must still publish when art cannot be produced.

The scene is derived from what the contribution actually changes, while the
Hermes Browser campaign character, palette and typography stay constant.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import site
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

DEFAULT_MODEL = "fal-ai/gpt-image-2"
ASPECT = "landscape_16_9"
CATBOX = "https://catbox.moe/user/api.php"
LITTERBOX = "https://litterbox.catbox.moe/resources/internals/api.php"
UGUU = "https://uguu.se/upload?output=text"

# Hosts tried in order, with how long the copy lives. A review comment is
# published once and read for months, so a host that expires the file in
# hours turns a good image into a broken one later. Permanent hosts come
# first; the longer-lived hosts are a last resort, never a primary.
#
# The retention values are the ones the host documents for each request. The
# host that actually stores the file is decided by the upload, so the reported
# lifetime comes back with the result rather than being assumed here.
HOSTS = [
    (CATBOX, "permanent"),
    (LITTERBOX, "72h"),
    (UGUU, "30d"),
]

POSES = [
    "standing on the lip of a floating browser terrace, one arm raised toward a newly completed structure",
    "walking forward along a translucent address-bar causeway with a steady, unhurried stride",
    "kneeling beside a repaired bridge joint, fitting a glowing panel into place",
    "seated sideways on the rail of a tall tab tower, legs hanging, looking back over her shoulder",
    "mid-leap between two floating windows, coat and hair trailing behind her",
    "standing at a drafting table of light, tracing a route across a floating map of windows",
    "climbing a spiral stair made of stacked browser tabs",
    "glancing upward at an orbiting ring of room windows while holding a control ledger",
    "reaching into a translucent browser sphere that scatters small interface cards",
    "standing at a cliff edge with her back to the camera, looking at a distant gate",
]

# A pose that performs the work the change actually does. Selected by keyword in
# the change's own title and body, so the character is doing this PR's job
# rather than a generic browser gesture.
TOPIC_POSES = [
    (r"\bsearch\b|\bfind\b|\bquery\b|\bindex\b",
     "seated at a wide desk of light in the lower frame, both hands typing into a glowing search field "
     "that clearly reads \"parallel search\", her head turned to her right and her eyes fixed on a "
     "single result card floating beside her that clearly reads \"web results\" with a short list of "
     "legible result titles, one hand reaching toward it"),
    (r"\bsession\b|\bchat\b|\bconversation\b",
     "seated at a wide desk of light, one hand resting on a small console while the other "
     "steadies a single open chat card that is filling with a reply, reading it"),
    (r"\bdoc\b|\bguide\b|\breadme\b|\bmanual\b|\btutorial\b",
     "seated at a wide reading desk in the lower frame, turning open a single heavy folio of "
     "light and reading the page in front of her, one finger resting on the line she is reading"),
    (r"\bconfig\b|\bsetting\b|\boption\b|\byaml\b|\bpreset\b",
     "standing at an open console in the lower frame, one hand turning a single physical dial "
     "on a clean panel while the other steadies a small open ledger"),
    (r"\bcontrol\b|\bclick\b|\binput\b|\btyp(e|ing)\b|\bkeypress\b",
     "leaning over a clean console in the lower frame, one hand on a large single control "
     "surface and the other hand reaching for one specific control, focused on it"),
    (r"\bvoice\b|\bspeak\b|\bmicrophone\b|\btranscri",
     "standing in the lower frame with a small microphone on a desk in front of her, one hand "
     "raised to speak, listening"),
    (r"\btab\b|\bwindow\b|\bfocus\b",
     "standing at a clean console in the lower frame, one hand resting on a single browser tab "
     "she has brought to the front, looking at it directly"),
    (r"\bfetch\b|\bdownload\b|\brequest\b|\bapi\b|\bhttp\b|\bendpoint\b",
     "seated at a wide desk of light in the lower frame, one hand on a console while a single "
     "clean data card travels along a short arc toward her, arriving in her hand"),
    (r"\btest\b|\bverif|\bassert\b|\bcheck\b",
     "kneeling in the lower frame beside a clean instrument console, one hand placing a single "
     "measuring marker onto a marked scale, checking it against the line"),
]

WORLDS = [
    "a bright cobalt sky above an archipelago of floating browser islands linked by tab bridges",
    "a monumental white marble colonnade whose arches open onto clouds and distant UI towers",
    "a night observatory of white stone, browser windows hung like constellations over a calm sea",
    "a shallow reflective causeway at dawn, wide flat water mirroring a browser-window skyline",
    "an open-air amphitheater carved into a cliff, rows of glowing message cards rising behind her",
    "a cloud gate with two enormous curved browser windows framing a bright horizon",
    "a quiet interior control gallery, tall white pillars, floating panels and one long window wall",
    "a coastal digital city at midday, white terraces stepping down toward luminous blue water",
]

# Worlds that suit a single, legible action over dense scenery.
FOCUSED_WORLDS = [
    "a quiet white study hall with tall plain pilasters, one long window wall, and nothing else in it",
    "a calm terrace at blue hour with a low plain stone parapet, open sky, empty floor",
    "a clean observatory gallery, one wide arched window, pale stone floor, nothing in the room",
    "a still white reading room with a vaulted ceiling and a single tall window, bare",
]


KIND_SCENES = {
    "feature": "one new element being added: a single clean module being seated into a console",
    "fix": "one repaired joint: a single panel being reseated into clean alignment",
    "docs": "a single open folio of light on a plain desk, quiet and precise",
    "test": "one measuring instrument being checked against a single marked scale",
    "refactor": "one repeated bay of clean columns, squared to the grid",
    "performance": "one long clean causeway where light moves without resistance",
    "localization": "one inscription, rendered clearly and legibly",
    "chore": "one surface being cleaned, the structure left orderly",
}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def classify(title: str, paths: list[str]) -> str:
    t = (title or "").lower()
    if re.search(r"\bfix|bug|regress|revert\b", t):
        return "fix"
    if re.search(r"^docs|documentation|readme", t) or paths and all(p.startswith(("docs/", "guides/")) or p.endswith(".md") for p in paths):
        return "docs"
    if re.search(r"^test|\btests?\b", t) or paths and all("test" in p for p in paths):
        return "test"
    if re.search(r"^perf|performance|speed", t):
        return "performance"
    if re.search(r"refactor|rename|extract|split|cleanup", t):
        return "refactor"
    if re.search(r"i18n|l10n|locale|translat", t) or paths and all(p.startswith("_locales/") for p in paths):
        return "localization"
    if re.search(r"^feat|add|support|implement|introduc|new ", t):
        return "feature"
    return "chore"


def clean_areas(paths: list[str]) -> list[str]:
    filtered = [p for p in paths if not (p.startswith(('_locales/', 'docs/')) or p.lower() in {'changelog.md', 'readme.md'})]
    if not filtered:
        filtered = paths
    topics = []
    seen = set()
    def add(item):
        if item not in seen:
            seen.add(item)
            topics.append(item)
    for p in filtered:
        low = p.lower()
        if 'browser-control' in low or 'browser_control' in low:
            add('Browser Control')
        if 'tab' in low:
            add('Show Tab')
        if 'session' in low:
            add('Session Binding')
        if 'theme' in low or 'appearance' in low:
            add('Themes')
        if 'voice' in low or 'wake' in low:
            add('Voice Dictation')
        if 'room' in low or 'bot' in low:
            add('Room Roster')
    if not topics:
        topics = ['Core Extension', 'Control Safety', 'Verification']
    while len(topics) < 3:
        for fallback in ['Control Safety', 'Verification Suite', 'Direct Focus']:
            if fallback not in seen:
                add(fallback)
                break
    return topics[:3]


def cool_headline(title: str, kind: str) -> str:
    t = re.sub(r'^(feat|fix|docs|refactor|test|chore|perf|style)(\([^)]+\))?:\s*', '', title or '', flags=re.I).strip()
    # Check for "replace X with Y" pattern
    m_replace = re.search(r'replace\s+(?:the\s+)?(.+?)\s+with\s+(?:a\s+|an\s+|the\s+)?(.+)', t, flags=re.I)
    if m_replace:
        feature = re.sub(r'\s+button|\s+action|\s+control', '', m_replace.group(2).strip(), flags=re.I)
        return f"{feature.upper()}. DIRECT FOCUS."
    # Check for "drop/remove X" pattern
    m_drop = re.search(r'(?:drop|remove)\s+(?:the\s+)?(.+?)(?:\s+when|\s+on|\s+if|\s+for|$)', t, flags=re.I)
    if m_drop:
        feat = m_drop.group(1).strip()
        return f"{feat.upper()}. REFINED."
    # "add opt-in X" reads badly as "ADD OPT. X." Name the capability instead.
    m_add = re.search(r'^(?:add|introduce|support|implement|enable|provide)\s+(?:an?\s+)?(?:opt-?in\s+|optional\s+)?(.+)$', t, flags=re.I)
    if m_add:
        subject = re.sub(r'\s+configuration$|\s+config$|\s+support$|\s+option$', '', m_add.group(1).strip(), flags=re.I)
        subject = re.sub(r'^(?:parallel|exa|tavily|brave|google)\s+', lambda mm: mm.group(0).strip().title() + ' ', subject)
        words = [w for w in re.findall(r'[A-Za-z0-9]+', subject) if w.lower() not in {'the', 'a', 'an', 'to', 'for', 'of', 'and', 'with', 'hermes'}]
        if words:
            phrase = ' '.join(words[:3]).upper()
            return f"{phrase}. { {'docs': 'DOCUMENTED', 'feature': 'EXPANDED'}.get(kind, 'ACTIVE') }."
    words = [w for w in re.findall(r'[A-Za-z0-9]+', t) if w.lower() not in {'in', 'on', 'the', 'a', 'an', 'to', 'for', 'of', 'and', 'with', 'when', 'is', 'from', 'v2', 'v1', 'hermes', 'button'}]
    if len(words) >= 4:
        return f"{' '.join(words[:2]).upper()}. {' '.join(words[2:4]).upper()}."
    elif len(words) in (2, 3):
        first = " ".join(words).upper()
        tag = {"fix": "STABILIZED", "feature": "EXPANDED", "docs": "DOCUMENTED", "test": "VERIFIED", "refactor": "REFINED", "perf": "OPTIMIZED"}.get(kind, "ACTIVE")
        return f"{first}. {tag}."
    elif len(words) == 1:
        tag = {"fix": "STABILIZED", "feature": "EXPANDED", "docs": "DOCUMENTED"}.get(kind, "ACTIVE")
        return f"{words[0].upper()}. {tag}."
    return "SHOW TAB. DIRECT FOCUS." if "show" in t.lower() else "PRECISION CONTROL. ACTIVE."


def subject_line(title: str, body: str) -> str:
    """A short, precise statement of what the change does.

    The raw pull-request body is checklists, badges and boilerplate. Feeding
    that to an image model produces a poster of unrelated detail, so the scene
    subject is reduced to the change's own words.
    """
    heading = re.search(r'##\s*What does this PR do\?\s*\n+(.{20,400}?)(?=\n\n|\n#|\Z)', body, flags=re.S)
    if heading:
        text = re.sub(r'\s+', ' ', heading.group(1)).strip()
        if text:
            return strip_markdown(text)[:300]
    first = re.sub(r'\s+', ' ', body).strip()
    if first:
        return strip_markdown(first)[:220]
    return strip_markdown(title or '')[:220]


def strip_markdown(text: str) -> str:
    """Remove markdown link syntax so the model reads prose, not markup."""
    text = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', text or '')
    text = re.sub(r'[*_`#>]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def select_pose(title: str, body: str, seed: bytes) -> tuple[str, str]:
    """Pick a pose that performs this change's work, and a world that stays calm.

    Returns (pose, world). A topic keyword match wins over the seeded rotation so
    the character is doing what the change does. The world is always a focused
    one: dense scenery reads as visual noise behind a headline.
    """
    text = f"{title}\n{body}"
    for pattern, pose in TOPIC_POSES:
        if re.search(pattern, text, flags=re.I):
            world = FOCUSED_WORLDS[seed[2] % len(FOCUSED_WORLDS)]
            return pose, world
    return POSES[seed[0] % len(POSES)], FOCUSED_WORLDS[seed[1] % len(FOCUSED_WORLDS)]



def build_prompt(kind: str, number: str, label: str, title: str, topic: str, areas: list[str], pose: str, world: str) -> str:
    features = " • ".join(a.replace("-", " ").title() for a in areas[:3]) or "Review • Evidence • Coverage"
    headline = cool_headline(title, kind)
    return f"""Create a masterpiece 16:9 widescreen software advertising poster in the official Hermes Browser Extension anime campaign style.

CRITICAL POSTER ARCHITECTURE & VERTICAL SEPARATION:
The canvas is strictly divided vertically:
- The entire TOP 38% OF THE CANVAS is an open, symmetrical, uncluttered sky and architectural frieze zone reserved EXCLUSIVELY for centered poster typography.
- The ILLUSTRATION (character, architecture, floating windows, islands) is located STRICTLY in the LOWER 62% of the canvas (below y = 38%).
- Absolutely NO character head, hands, hair, buildings, towers, or floating windows may enter or touch the top 38% of the frame.
- Nothing in the image must EVER push, displace, wrap around, or offset the text to the right or left.

TYPOGRAPHY CLEARANCE (CRITICAL):
- Leave a generous EMPTY margin of open sky above the top line, roughly 6% of the canvas height, so the header never feels cropped.
- The arched headline must not touch the left or right edge; keep at least 8% clear canvas width on each side of the headline's outermost letters.
- The headline arch must be shallow and even. Do NOT let the outer letters of the headline descend steeply toward the edges.
- Every text line sits fully inside the canvas with clean air above and below it. No element may overlap, crowd, or visually cut into a line of type.
- The subcategory line must sit clear of the headline with a visible gap, and clear of the illustration below it.

CLARITY AND RESTRAINT (CRITICAL - THIS IS WHAT MAKES IT LOOK PREMIUM):
- Keep the composition SPARSE, CALM and READABLE. One subject, one action, almost no props.
- The background must be quiet and mostly EMPTY. A plain pale wall, ONE tall window, a plain floor. NO bookshelves, NO stacks of books, NO flowers, NO hanging banners or flags, NO emblems on the walls, NO statues, NO armillary spheres, NO cats, NO ornate wall mouldings, NO landscape beyond the window, NO mountains, NO castles, NO ornate ceiling.
- No more than TWO tall plain columns in the whole scene, and no ornament on them.
- The desk must be ONE clean surface with ONE straight edge, not a layered reflective console with multiple bright rails.
- Do NOT stack many overlapping translucent browser panels around the character. At most TWO interface cards in the whole image, well separated from each other and from the character.
- Do NOT scatter tiny pseudo-text, miniature labels, or unreadable glyphs across the scene. Each interface card carries ONE short, large, fully legible word or phrase, and nothing else.
- Keep strong value separation: crisp white and blue shapes against calm flat background areas. Avoid heavy blue glow that merges neighbouring forms into mush.
- Leave large calm areas of sky, wall, and floor. Negative space is what makes the poster read as premium rather than busy.
- Reduce rendering detail in the environment. Forms should be simple, clean and confident, not densely illustrated.
- Nothing in the background should compete with the character or the typography.


HEADER TYPOGRAPHY (EVERY ELEMENT IS 100% HORIZONTALLY CENTER-ALIGNED ON THE CANVAS MIDLINE, WITH EQUAL MARGINS ON LEFT AND RIGHT):
1. TOP LINE (centered at top):
   ——— HERMES BROWSER EXTENSION ———
   (Flanked on left and right by razor-straight, perfectly symmetrical horizontal thin white lines).
2. SUB-LOCKUP (centered directly beneath top line):
   {label} #{number}
3. ARCHED DISPLAY HEADLINE (centered across upper sky):
   A dominant, majestic, bold condensed sans-serif display headline, gleaming white with subtle royal blue glow, rendered in an elegant, symmetrical arch or centered band spanning the upper center:
   {headline}
4. SUBCATEGORY LINE (centered directly beneath the headline):
   Clean uppercase sans-serif with middle dot bullets:
   {features}

HERMES BROWSER GIRL (CHARACTER IN LOWER TWO-THIRDS):
- Positioned in the lower center or lower-middle of the frame (y > 42%), fully visible and clearly separated from the typography above.
- She performs ONE specific, legible action that matches the change: {pose}
- The action must read instantly at thumbnail size. Her hands, her gaze, and the one object she touches must all point at the same thing.
- Her expression is focused and intelligent, looking at the thing she is working on.
- Long dark navy blue-black hair, straight softly shaped bangs, large circular over-ear blue-and-white headphones.
- Sporty white-and-blue aerodynamic outfit with clearly visible modest fitted athletic undershorts under any skirt layer. Strictly modest, non-suggestive, dignified, intelligent.
- MANDATORY SKIN TREATMENT: Achromatic pure paper-white graphic fill with cool blue shadows only. ZERO peach, beige, tan, pink, brown, or natural flesh tones anywhere. The skin reads like crisp white anime manga ink on paper.

SCENE SETTING (LOWER FRAME ONLY):
Subject of this contribution: {topic}
Visual metaphor: {KIND_SCENES.get(kind, KIND_SCENES['chore'])}
Character pose: {pose} (framed strictly in the lower two-thirds of the image)
Environment: {world}
- The environment is QUIET and SPARSE. It exists to frame the character, not to fill the canvas.
- Neoclassical white architecture in the lower midground only: a few clean pilasters, a low parapet, a single tall window or arch. No dense scenery, no crowds of distant buildings, no stacked clutter.
- At most two or three translucent interface cards in the entire image, each well separated, each carrying ONE short, large, fully legible word or phrase (such as a magnifying glass beside a search field that reads "parallel search", or a result card that reads "web results"). Use real readable words, not placeholder bars or tiny illegible glyphs.
- No busy distant detail: no castles, no islands, no crowds of tiny windows, no decorative filigree. Calm, clean, premium.

COLOR & FINISH:
Dominated by vivid Hermes royal blue (#0000F2) and pure paper white, with subtle pale cyan highlights and deep navy linework. High-end, razor-sharp anime advertising key visual. No 3D CGI or Pixar style, no warm orange/yellow tint, no muddy shadows.
"""

def render_image(prompt: str, model: str, target: Path) -> tuple[str, str]:
    """Generate through the installed Hermes image tool, so the managed provider
    and its credentials resolve exactly as they do for interactive use."""
    runtime = os.environ.get("HERMES_REVIEW_RUNTIME_ROOT", "")
    if not runtime or not Path(runtime, "tools", "image_generation_tool.py").is_file():
        raise RuntimeError("Hermes runtime root unavailable for image generation")
    packages = os.environ.get("HERMES_REVIEW_SITE_PACKAGES", "")
    if packages:
        site.addsitedir(packages)
    if runtime not in sys.path:
        sys.path.insert(0, runtime)
    notify = io.StringIO()
    with contextlib.redirect_stdout(notify), contextlib.redirect_stderr(notify):
        from hermes_cli.config import load_env
        load_env()
        from tools.image_generation_tool import _get_plugin_provider
        provider = _get_plugin_provider(model) if model and model != DEFAULT_MODEL else None
        if provider is None or not provider.is_available():
            provider_name = "openai-codex"
            provider = _get_plugin_provider(provider_name)
        if provider is None or not provider.is_available():
            raise RuntimeError("configured image backend is unavailable")
        result = provider.generate(prompt, "landscape")
    if isinstance(result, str):
        result = json.loads(result)
    if not result.get("success") or not result.get("image"):
        raise RuntimeError(str(result.get("error_type") or "image generation failed"))
    location = str(result["image"])
    if location.startswith(("http://", "https://")):
        with urllib.request.urlopen(location, timeout=180) as response:
            target.write_bytes(response.read())
    else:
        source = Path(location)
        if not source.is_file():
            raise RuntimeError("generated image is unavailable")
        target.write_bytes(source.read_bytes())
    return str(result.get("model") or model), location


def _curl_upload(args: list[str]) -> str:
    # A fresh cookie jar per upload. The host issues a PHP session and can
    # throttle a request that arrives without one, which looks identical to a
    # broken file. A new session also keeps a throttled attempt from poisoning
    # later ones.
    jar = Path(tempfile.gettempdir()) / f"hermes-review-upload-{os.getpid()}-{time.time_ns()}.cookies"
    try:
        result = subprocess.run(
            ["curl", "-sS", "-c", str(jar), "-b", str(jar)] + args,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    finally:
        try:
            jar.unlink()
        except OSError:
            pass
    return (result.stdout or "").strip() if result.returncode == 0 else ""


def _download_size(url: str) -> int:
    """Bytes actually served for a hosted file, or -1 when it cannot be read."""
    result = subprocess.run(
        ["curl", "-sSL", "-A", "Mozilla/5.0", "-o", os.devnull, "-w", "%{size_download}", url],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
    )
    try:
        return int((result.stdout or "0").strip())
    except ValueError:
        return -1


def _hosted_intact(url: str, expected: int) -> bool:
    """A host that accepted an upload can still store a truncated copy. Verify."""
    served = _download_size(url)
    return served == expected


def _reencode(source: Path, attempt: int) -> Path:
    """Re-encode the artwork so the next upload has different bytes and size.

    A host that truncated one body can truncate the next identically shaped
    body. JPEG at a fresh quality changes both the payload and the size, which
    is what actually makes large uploads survive.

    The trailing marker also guarantees a content hash the host has never seen.
    Hosts that de-duplicate by hash will otherwise return the same broken URL
    for the same bytes, so re-uploading identical content can never recover.
    """
    target = source.with_name(f"{source.stem}-r{attempt}.jpg")
    try:
        from PIL import Image

        with Image.open(source) as image:
            image.convert("RGB").save(target, "JPEG", quality=92 - (attempt * 4), optimize=True)
    except Exception:
        target = source.with_name(f"{source.stem}-r{attempt}.bin")
        target.write_bytes(source.read_bytes() + b"\x00" * attempt)
        return target
    with target.open("ab") as handle:
        handle.write(f"\nhermes-review-{attempt}-{time.time_ns()}".encode())
    return target


def _host_args(host: str, candidate: Path) -> list[str]:
    if host == CATBOX:
        return ["-f", "-F", "reqtype=fileupload", "-F", f"fileToUpload=@{candidate}", CATBOX]
    if host == LITTERBOX:
        return ["-f", "-F", "reqtype=fileupload", "-F", "time=72h", "-F", f"fileToUpload=@{candidate}", LITTERBOX]
    # Ask for the longest retention the host offers. Without it the copy
    # expires in hours and a published review image breaks days later.
    return ["-f", "-F", "time=30d", "-F", f"files[]=@{candidate}", UGUU]


def upload_image(filename: str) -> tuple[str, Path, str]:
    """Upload, then prove the hosted copy is byte-complete before returning its URL.

    Catbox accepts a large upload and can still persist a truncated body, which
    renders as a broken image in the review. Every candidate URL is read back and
    compared with the local file size; a short read is retried with re-encoded
    bytes so the host's content hash and payload size both change.

    Hosts are tried in order of how long they keep the file. A published review
    comment is read for months, so a short-lived host is only acceptable once
    every permanent one has failed, and the caller is told which kind it got.

    A host that rate-limits a burst of uploads rejects the next request instead
    of storing it. Backing off and retrying the same host is better than
    switching to a shorter-lived one, so rejections are retried with a pause.

    Returns the verified URL, the file that was actually uploaded (not always
    the original: a re-encode becomes the hosted body), and the host's lifetime.
    """
    source = Path(filename)
    candidate = source
    # Try the permanent host with the original and then with re-encoded bodies.
    # Only after that does the chain move on to hosts that expire the file.
    for host, lifetime in HOSTS:
        attempt = 0
        rejections = 0
        while attempt < 4:
            args = _host_args(host, candidate)
            url = _curl_upload(args)
            if url.startswith("https://") and _hosted_intact(url, candidate.stat().st_size):
                return url, candidate, lifetime
            if not url.startswith("https://"):
                # Rejected: the host is throttling. Wait it out and try again
                # rather than abandoning a permanent host for a temporary one.
                rejections += 1
                if rejections >= 3:
                    break
                time.sleep(20 * rejections)
            attempt += 1
            candidate = _reencode(source, attempt)
            time.sleep(3)
    raise RuntimeError("image host upload failed or served a truncated file")


def hermes_env_value(name: str) -> str:
    """Read one credential from the Hermes env file when the process env lacks it."""
    if os.environ.get(name, "").strip():
        return os.environ[name].strip()
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    env_file = Path(home) / ".env"
    try:
        for raw in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[7:]
            if line.startswith(f"{name}="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    except OSError:
        return ""
    return ""


def main() -> int:
    request = json.load(sys.stdin)
    if os.environ.get("HERMES_REVIEW_ART", "1") != "1":
        print(json.dumps({"ok": False, "reason": "art disabled"}))
        return 0
    number = str(request.get("number", ""))
    title = str(request.get("title", "") or "")
    paths = [str(p) for p in request.get("paths", [])][:40]
    kind = classify(title, paths)
    areas = clean_areas(paths)
    seed = hashlib.sha256(f"{number}:{title}:{request.get('headSha', '')}".encode()).digest()
    pose, world = select_pose(title, str(request.get("body", "") or ""), seed)
    label = "PR" if request.get("kind") == "pull_request" else "ISSUE"
    topic = subject_line(title, str(request.get("body", "") or ""))
    model = os.environ.get("HERMES_REVIEW_ART_MODEL", DEFAULT_MODEL)
    prompt = build_prompt(kind, number, label, title, topic, areas, pose, world)
    output = Path(request.get("directory") or "D:/HermesCaches/hbe-review-watch/art")
    output.mkdir(parents=True, exist_ok=True)
    image = output / f"{label.lower()}-{number}-{request.get('headSha', 'x')[:12]}-{uuid.uuid4().hex[:6]}.png"
    try:
        served_model, _ = render_image(prompt, os.environ.get("HERMES_REVIEW_ART_BACKEND", "openai-codex"), image)
        url, uploaded, lifetime = upload_image(str(image))
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": type(exc).__name__, "detail": str(exc)[:200], "kind": kind, "model": model}))
        return 0
    # The hosted body is the file that was actually uploaded, which is not
    # always the generated PNG: a truncated upload is retried as a re-encode.
    print(json.dumps({"ok": True, "url": url, "bytes": _download_size(url), "model": served_model or model, "kind": kind, "pose": pose, "world": world, "prompt": prompt, "file": str(uploaded), "host_lifetime": lifetime}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
