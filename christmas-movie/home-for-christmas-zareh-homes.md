# Home for Christmas: A Zareh Homes Short
A 90s Christmas short film starring Daniel. 15 scenes × 10s = 2:30. 9:16 for Reels / TikTok.

**Logline:** It's December. Maya and Josh have lost four offers this year and are about to give up and renew their lease. Their realtor, Daniel, finds them one more house.

- **Want:** their first home before Christmas
- **Problem:** four lost offers, and they're done trying
- **Warm ending:** on Christmas Eve, Daniel hands them a brass key ornament. "Closing's January 15th. But I couldn't wait."

The pipeline is the same as `the-last-christmas-on-maple-street.md`: style prefix, voice swap, sound effects, score and ffmpeg. Only the differences are below.

---

## 1. Getting you in it (do this first)

**Your face**
- Take 10–15 recent photos: front, three-quarter, side, a full body shot, smiling and neutral. Use even daylight, no sunglasses, no hat.
- Feed them into GPT Image 2.5 as references for your character sheet. This replaces the "original face" rule, since it's your own likeness.
- Do the 2-take check on every scene where you're in the shot. AI drifts most on real faces.

**Your voice**
- Use ElevenLabs **Voice Cloning**, not Voice Design.
- Instant clone: about 1–2 minutes of clean audio is enough to test.
- Professional clone: 30+ minutes, and it sounds much more like you. I'd go with this if you'll reuse it for future content.
- Record in a quiet room, talking naturally like you're on a call with a client. Don't read in a "radio voice."
- Every one of your lines goes through Voice Changer with your clone.

**Compliance**
- The end card needs your brokerage name to meet RECO advertising rules.
- Maya and Josh are fictional, so no client consent is needed.

---

## 2. Style prefix (start of EVERY image and video prompt)

```
Shot on 35mm Kodak film in 1994, warm tungsten light inside, soft blue snowy light outside, fine film grain, soft glow on the Christmas lights, slightly faded blacks, real skin with no makeup gloss. 90s details only: chunky knit sweaters, flannel, wood paneling, plaid couches, CRT TVs, big bulb Christmas lights with tinsel, station wagons, a diner with a neon sign, fax machines, pagers, printed MLS books, Polaroids, snow falling slowly. No phones, no LED lights, no modern cars, no logos, no text. Vertical 9:16.
```

---

## 3. Characters

| Character | Look (sheet prompt) | Voice |
|---|---|---|
| **Daniel** (you) | From your reference photos. 1994 realtor: charcoal wool overcoat, burgundy knit scarf, cream cable-knit sweater over a collared shirt, dark trousers, leather briefcase, pager clipped on his belt. | **Your voice clone** |
| **Maya** (31) | Woman, 31, dark curly hair pulled back, warm brown skin, small gold hoop earrings. Oversized mustard knit sweater, puffy forest-green jacket, jeans, winter boots. Original face. | A 31 year old Canadian woman, warm and expressive, a little breathy when emotional, quick to laugh. |
| **Josh** (32) | Man, 32, short light-brown hair, clean shaven, glasses with thin wire frames. Navy flannel shirt over a white tee, tan corduroy jacket. Original face. | A 32 year old Canadian man, soft-spoken and slightly nervous, with a dry, gentle sense of humour. |

## 4. Location plates (empty, no people)

| Plate | Prompt (after style prefix) |
|---|---|
| **Apartment** | Small rental apartment, beige walls, plaid couch, CRT TV, a tiny tabletop Christmas tree, window with snow, kitchen table with papers and two mugs. |
| **Diner** | Small-town diner at night, red vinyl booths, neon sign glowing through the snowy window, an open thick printed MLS book and coffee on the table. |
| **Townhouse – exterior** | Brick two-storey townhouse on a quiet snowy street, small front porch, one porch light, a little evergreen by the steps, a lockbox on the door handle, dusk. |
| **Townhouse – interior** | Empty townhouse living room, hardwood floors, brick fireplace with wood mantel, big front window looking at snowy street, no furniture. |
| **Office** | 1994 real estate office at night, wood desks, beige fax machine, yellow wall phone with curly cord, corkboard of Polaroid house photos (no text), desk lamp. |

---

## 5. Scenes

| # | Shot | Action | Line (with audio tags) | SFX | Music |
|---|---|---|---|---|---|
| 1 | Slow push in | Christmas Eve, outside the townhouse. Maya opens a small box. Brass key ornament. She's crying. | **Maya:** [whispers] It's really ours? | Snow wind | Swell |
| 2 | Wide | Title card over the snowy street: *Earlier that December* | — | Wind | Soft |
| 3 | Wide | Apartment. Maya and Josh at the kitchen table, papers everywhere. | **Josh:** [sighs] Fourth offer. Fourth no. | Radiator hiss | None |
| 4 | Close up | Maya staring out the snowy window. | **Maya:** [quietly] Maybe we just renew the lease. | Muffled street | None |
| 5 | Slow push in | Diner. Daniel flipping through the MLS book, stops on a page, taps it. | **Daniel:** [to himself, half smile] Not saying this is the one, but… | Diner hum, page flip | Soft |
| 6 | Wide | Station wagon pulls up to the townhouse. Daniel opens the lockbox as Maya and Josh walk up. | **Daniel:** Just so you have the full picture… it needs some work. | Car doors, snow crunch | Soft |
| 7 | Close up | Inside. Maya touches the fireplace mantel. | **Maya:** [softly] I can see the tree right there. | Empty room echo | Soft |
| 8 | Close up | Josh by the window, nervous. | **Josh:** [nervous laugh] We can't lose another one. | Wind | Soft |
| 9 | Slow push in | Daniel turns to them, calm. | **Daniel:** We won't rush it. We do it right this time. | Floor creak | Soft |
| 10 | Wide | Office, late night. Daniel waits by the fax machine. It starts printing. | **Daniel:** [exhales] Come on… | Fax screech, clock tick | Building |
| 11 | Close up | Daniel on the yellow wall phone, grinning. | **Daniel:** [smiling] They accepted. | Phone cord rustle | Building |
| 12 | Wide | Apartment. Maya and Josh hugging and jumping, the tiny tree shaking. | **Maya:** [screams, laughs] We got it! | Laughter, ornaments jingling | Soft swell |
| 13 | Slow push in | Christmas Eve. Daniel walks up the snowy townhouse path with a small wrapped box. | **Daniel:** Closing's January 15th. But I couldn't wait. | Snow crunch, sleigh bells | Soft |
| 14 | Close up | Maya opens it. Brass key ornament. Josh puts his arm around her. | **Josh:** [voice breaking] That's our key. | Wind | Swell |
| 15 | Wide | Maya hangs the ornament on the little evergreen by the steps. Daniel walks back to his wagon, looks back. | **Daniel:** [softly] At the end of the day, it's just a house. Until it's home. | Wind, sleigh bells | Swell, resolve |

**End card** (added in ffmpeg, over the snowy street):
> Merry Christmas from Zareh Homes
> Daniel Zareh · [Brokerage name]

---

## 6. Talking close ups (Chimera / ElevenCreative)
Scenes 4, 7, 8, 11, 14. Use one image from the character sheet plus the line above. **Scene 11 uses your voice clone.**

## 7. Extra sound effects
- 90s fax machine connecting and printing
- Old wall phone cord rustle and handset pickup
- Steam radiator hiss in a small apartment
- Pager beep (optional, scene 5)

## 8. Captions

1. Their first Christmas as homeowners. 🎄
2. Earlier that December…
3. Four offers. Four no's.
4. Almost gave up.
5. Not saying this is the one, but…
6. Just so you have the full picture.
7. When you can picture the tree, you know.
8. After four losses, the fifth one is scary.
9. Slow down. Do it right.
10. Every agent knows this wait.
11. "They accepted." Best call of the year.
12. This is why I do this. ❤️
13. Closing's in January. Couldn't wait.
14. Their key. Their home.
15. At the end of the day, it's just a house. Until it's home. Merry Christmas from Zareh Homes. 🎄
