# Jones Manoel creator fit

Scope videos:

- https://www.youtube.com/watch?v=eO2i25qDxqU — Câmara do Rio de Janeiro aprova a criminalização da crítica ao sionismo
- https://www.youtube.com/watch?v=-c-n5vGG3zg — O falso debate sobre defesa nacional
- https://www.youtube.com/watch?v=THkqXpk802E — Renan Santos defende agressores de mulheres?
- https://www.youtube.com/watch?v=hgoR6S4kkx4 — Lula, Ciro Gomes e o que é ser de esquerda

## Initial fit

Jones appears to fit the engine better as a single-speaker argumentative creator than as a split-screen/react layout. The planning layer should keep using the generic semantic arc objective: hook/setup -> turn -> explanation/evidence -> payoff. The likely shorts are not chapter slices; they are compact political argument transformations, e.g. “the stated debate is X, but the real political structure is Y”.

## Static artifacts needed now

1. `profiles/jones_manoel_layout.json`
   - Current baseline: center vertical crop from a 16:9 source into 9:16.
   - This assumes Jones is the primary centered speaker in the source video.
   - It deliberately does not encode creator-specific logic in the renderer.

2. Per-run `.env` override
   - `TELEGRAM_SHORTS_STATIC_LAYOUT_PATH=profiles/jones_manoel_layout.json`
   - Keep `TELEGRAM_SHORTS_RENDER_TIER=dev` for test runs.

3. Optional future artifacts after sampling actual frames
   - alternate layout profile if a recurring Jones format places the speaker off-center or uses a source panel/slides layout;
   - creator-specific transcript/planning notes only if the generic semantic arc planner misses his rhetorical structure.

## Baseline layout rationale

A 16:9 source cropped to vertical 9:16 needs a normalized width of `(9/16)/(16/9) = 0.316`. Centering gives `x = 0.342`. The profile maps that center strip to the full vertical canvas and keeps subtitles in the lower safe area.

## Current blocker to a full engine run

Local `yt-dlp` extraction for these URLs is currently blocked by YouTube bot/cookie enforcement before the engine can download/transcribe the source. YouTube oEmbed still resolves titles/thumbnails, so the URLs are public, but the local download path needs valid cookies or an extractor-auth solution before end-to-end testing.

## What to verify once source download works

- Jones remains a single strong speaker; if not, use explicit `--speaker <speakerId>` for local `process-once`.
- Center crop keeps face/gestures in frame across the four samples.
- Subtitles do not cover the mouth/chin; adjust only `subtitleSafeArea` if needed.
- Semantic candidates should be self-contained arguments, not news-topic summaries.
