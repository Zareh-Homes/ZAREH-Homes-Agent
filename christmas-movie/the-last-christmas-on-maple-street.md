# The Last Christmas on Maple Street
A 90s Christmas short film. 15 scenes × 10s = 2:30. 9:16 for Reels / TikTok.

**Logline:** Claire comes home for one last Christmas in the house she grew up in before it's sold. Next door is Ben, the boy she left behind.

- **Want:** one last perfect Christmas in the house
- **Problem:** the house is sold, closing is January 2nd, and Ben is still next door
- **Warm ending:** Ben is the one who bought it, so the porch light stays on

---

## 1. Style prefix (paste at the start of EVERY image and video prompt)

```
Shot on 35mm Kodak film in 1994, warm tungsten light inside, soft blue snowy light outside, fine film grain, soft glow on the Christmas lights, slightly faded blacks, real skin with no makeup gloss. 90s details only: chunky knit sweaters, flannel, wood paneling, plaid couches, CRT TVs, big bulb Christmas lights with tinsel, station wagons, a diner with a neon sign, snow falling slowly. No phones, no LED lights, no modern cars, no logos, no text. Vertical 9:16.
```

---

## 2. Characters (GPT Image 2.5 character sheets)

Sheet prompt template (after the style prefix):
```
Character reference sheet on a plain warm-grey background: front view, three-quarter view, side view, full body, and 3 facial expressions (neutral, laughing, teary). Same person in every panel, same outfit. Original face, does not resemble any real actor or celebrity. [CHARACTER DESCRIPTION]
```

| Character | Description | Voice Design (ElevenLabs, 1 sentence) |
|---|---|---|
| **Claire** (28) | Woman, 28, shoulder-length wavy chestnut hair, freckles, tired kind eyes. Cream chunky cable-knit sweater, long wool camel coat, red knit scarf, jeans, brown snow boots. | A warm 28 year old American woman with a soft small town accent, a little breathy, quick to laugh. |
| **Ben** (29) | Man, 29, short messy dark-blond hair, light stubble, broad shoulders, gentle smile. Red-and-black buffalo plaid flannel over a grey thermal, canvas work jacket, worn work boots. | A 29 year old American man with a low, calm, slightly gravelly voice and an easygoing small town pace. |
| **Mom (Linda)** (58) | Woman, 58, short silver-streaked brown hair, reading glasses on a beaded chain, laugh lines. Green Christmas cardigan with tiny embroidered trees over a turtleneck. | A 58 year old American mom with a gentle, slightly raspy voice, unhurried and warm, like she's always about to hug you. |

## 3. Location plates (empty, no people)

| Plate | Prompt (after style prefix) |
|---|---|
| **House – exterior** | Two-storey white clapboard house with green shutters and a covered front porch, single yellow porch light on, big multicolor bulb lights along the roofline, snowy front yard, a 1990s wood-panel station wagon in the driveway, dusk. Empty, no people. |
| **Living room** | Wood-paneled living room, plaid couch, CRT TV with rabbit ears, tall real Christmas tree with big bulb lights, silver tinsel and a gold star, brick fireplace with stockings, packed moving boxes along one wall. Empty, no people. |
| **Kitchen** | Small 90s kitchen, oak cabinets, yellow wall phone with a curly cord, frosted window above the sink, plate of sugar cookies on the counter. Empty, no people. |
| **Diner** | Small-town diner at night, red vinyl booths, chrome counter, pink-and-blue neon sign glowing through the snowy window, steam from coffee mugs. Empty, no people. |
| **Street** | Quiet snowy residential street at night, houses with big bulb Christmas lights, old street lamps, snow falling slowly. Empty, no people. |

---

## 4. Scenes

Seedance 2.5 prompt = style prefix + plate + sheet refs + the action below + the spoken line (for lip movement). One slow camera move per scene. 2 takes each, keep the one with the right face and clean hands.

| # | Shot | Action | Line (with audio tags) | SFX | Music |
|---|---|---|---|---|---|
| 1 | Slow push in | Living room, night. Claire on a step stool, straightening the gold star. Ben behind her. Tears in her eyes. | **Claire:** [whispers] You still put the star on crooked. | Fireplace crackle | Swell |
| 2 | Wide | Title card over the snowy street: *Earlier that December* | — | Snow wind | Soft |
| 3 | Wide | Station wagon pulls into the driveway. Claire steps out, looks up at the house. A "SOLD" sign is NOT shown (no text). | **Claire:** [sighs] One more Christmas. | Car door, snow crunch | Soft |
| 4 | Close up | Mom opens the front door, porch light behind her. | **Mom:** [softly] There's my girl. | Door creak, wind | Soft |
| 5 | Slow push in | Living room full of moving boxes. Claire touches the wood paneling. | **Claire:** [quietly] It already sounds empty. | Clock ticking, fireplace | None |
| 6 | Wide | Claire shovels the walk. Next door, Ben is hanging lights on a ladder. He stops. | **Ben:** [surprised] Claire Whitaker. | Shovel scrape, wind | None |
| 7 | Close up | Claire, caught off guard, a small smile. | **Claire:** [laughs] Hi, Ben. | Distant sleigh bells | Soft |
| 8 | Wide | Diner booth. Two coffees. Snow outside the neon window. | **Ben:** [teasing] You left for the big city and never wrote. | Diner chatter, coffee pour | Soft |
| 9 | Close up | Claire looks down at her mug. | **Claire:** [softly] I wanted to. Every Christmas. | Diner hum | Soft |
| 10 | Slow push in | Kitchen. Mom hands Claire a cookie, sees her face. | **Mom:** [gently] He never moved away, you know. | Oven ticking | Soft |
| 11 | Wide | Claire and Ben carry the tree in through the front door, laughing, snow on their shoulders. | **Ben:** [laughs] Your dad always said left side heavier. | Rustling branches, laughter | Soft |
| 12 | Close up | Claire on the porch, staring at the house. Ben beside her. | **Claire:** [voice breaking] Somebody else gets this porch next year. | Wind, porch chimes | None |
| 13 | Slow push in | Ben looks at her, nervous, pulls a single old brass key from his pocket. | **Ben:** [quietly] Not somebody else. | Key jingle | Soft |
| 14 | Close up | Claire realizes. Hand over her mouth, laughing and crying. | **Claire:** [gasps, laughs] You bought it? | Fireplace crackle | Building |
| 15 | Wide | Exterior. Porch light on, snow falling. Claire and Ben in the window putting the star up, crooked. Mom watching from the doorway. | **Ben:** [softly] Porch light stays on. | Wind, sleigh bells | Swell, then resolve |

**Cold open → story:** Scene 1 is the emotional moment (scene 14/15 timeline), then Scene 2 cuts to "Earlier that December."

---

## 5. Audio pipeline (per scene)

1. Pull audio from the Seedance clip.
2. ElevenLabs **Voice Isolator** to clean it.
3. **Speech to Text** with timestamps to locate the line.
4. **Voice Changer** with that character's designed voice.
5. Drop it back at the same timestamp (lips still match, only the voice changes).

**Chimera talking close ups** (scenes 4, 7, 9, 12, 14): one image from the character sheet + the line above with tags, in their voice. If Chimera isn't available via MCP, run these in ElevenCreative with the same image / line / voice.

## 6. Sound effects (ElevenLabs Sound Effects)
- Gentle snow wind outside a small house at night
- Crackling fireplace in a quiet living room
- Distant sleigh bells in the snow
- Small-town diner ambience, coffee pour, soft chatter
- Snow shovel scraping a sidewalk
- Old wooden front door creak

## 7. Score (ElevenLabs Music)
```
Instrumental 90s Christmas movie score, 2 minutes 30 seconds. Soft orchestra, celesta, sleigh bells, warm strings. Opens with a big emotional swell for 10 seconds, settles into a gentle, nostalgic theme, builds slowly from 2:00, big string swell at 2:10, resolves softly on celesta. No vocals, no existing songs.
```
Duck the music ~12 dB under every line.

---

## 8. Assembly (ffmpeg)

```bash
# 1) Normalize each scene to 1080x1920, 24fps
for i in $(seq -w 1 15); do
  ffmpeg -y -i scene_$i.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=24" \
    -c:v libx264 -crf 18 -c:a aac -ar 48000 norm_$i.mp4
done

# 2) Concat
ls norm_*.mp4 | sed "s/^/file '/; s/$/'/" > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c copy movie_raw.mp4

# 3) Score with ducking under dialogue + subtle film grain
ffmpeg -y -i movie_raw.mp4 -i score.mp3 -filter_complex \
 "[1:a]volume=0.8[m];[m][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck];[duck][0:a]amix=inputs=2:duration=first[a];\
  [0:v]noise=alls=8:allf=t,eq=contrast=0.97:brightness=0.01[v]" \
 -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac the_last_christmas_on_maple_street.mp4
```

Title card: classic 90s serif (e.g. Garamond / Baskerville style) over the snowy street plate. "The Last Christmas on Maple Street."

---

## 9. Captions (one per clip)

1. Some people come home for Christmas. Some come home for good. 🎄
2. Earlier that December…
3. One more Christmas in the house I grew up in.
4. Moms always know. ❤️
5. It's strange how quiet a house gets when it's packed.
6. Some people never left.
7. "Hi, Ben." That's all I had.
8. Diner coffee and the conversation we never had.
9. I wanted to write. Every Christmas.
10. Moms say the quiet part out loud.
11. Left side heavier. Every single year.
12. The hardest part of selling a home isn't the paperwork.
13. Not somebody else.
14. He bought it. 🥹
15. The porch light stays on. Merry Christmas. 🎄
