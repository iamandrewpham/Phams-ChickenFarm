# Why house temps move the way they do

Notes behind the numbers in `weatherLines()`. If you change a threshold in the
script, change the reasoning here too so the next person knows why.

A caveat up front: the physics below is general and reliable. The *target*
temperatures are not in here on purpose — those depend on bird age and your
integrator's grow-out program, and they're the one thing you should never take
from a script's README.

---

## Why the drop is bigger some nights than others

Outside low is the obvious driver, but it's a poor predictor on its own. Two
nights with the same 45° low can behave completely differently inside. Three
things explain most of the gap.

### Clear skies (the big one)

A house loses heat upward as infrared radiation through the roof. When clouds
are present they absorb that radiation and re-emit much of it back down — the
sky effectively acts like a blanket. On a clear night there's nothing overhead
to send it back, and the roof radiates straight out to deep space, which is
functionally at absolute zero.

This is why frost forms on clear nights at 38° and not on cloudy nights at 34°.
Same air temperature, very different surface heat loss.

**In the report:** cloud cover under 30% overnight triggers the radiant-cooling
warning.

### Calm wind

Counterintuitive, but calm air makes radiational cooling *worse*, not better.
Wind mixes the air near the ground with warmer air above, which keeps surfaces
from cooling as sharply. Dead-calm air lets a cold layer stack up right against
the house and stay there.

So clear *and* calm together is the worst case — that's why the script requires
both (cloud <30% and wind <5 mph) before it flags the night.

### Dew point

Water vapor is a greenhouse gas. Humid air holds heat and resists the temperature
drop; dry air sheds it fast. A 55° dew point night will fall much further than a
70° dew point night from the same starting temperature.

Dew point also puts a hard floor under how far the air can cool — it will not
drop far below its dew point without condensing out moisture, and that
condensation releases heat. So the dew point is roughly the overnight low.

### What compounds all three inside a poultry house

- **Minimum-vent fans run on timers**, not on temperature. Every cycle pulls in
  a slug of outside air regardless of what the house needs. On a cold night
  those cycles are exactly the loss you're fighting.
- **Bird age drives the heat budget.** Full-grown birds put out serious body
  heat and can carry a house through a cold night on their own. Day-old chicks
  produce almost none, so the brooders are doing all the work — a cold snap
  during brooding is a different problem than the same snap at week six.
- **Heater capacity is sized to a design temperature.** Below that point the
  burners simply run continuously and the house loses ground. That's the
  scenario where a temp alarm isn't a fluke, it's arithmetic.
- **Leaks scale with wind.** Curtain seams, inlet gaskets, and door seals leak
  by pressure difference, so a 20 mph night infiltrates far more than a calm one
  even at identical air temperature.

---

## Heat — the bigger risk in Mississippi

Nine months a year the cold is the interesting problem here. The other three,
it's the opposite, and heat kills faster than cold.

### Why afternoon, not noon

Ground and building mass keep absorbing heat after solar noon and release it
slowly, so peak house temperature runs hours behind peak sun — usually 3–6 p.m.
Staging fans at the temperature you see at noon means you're already behind.

**In the report:** forecast highs at or above 88° trigger the early-staging note.

### Why humidity ruins the cooling

Cool cells and foggers are evaporative — they work by converting sensible heat
into latent heat as water evaporates. The amount of cooling available is set by
the gap between the air's dry-bulb temperature and its wet-bulb temperature. A
high dew point closes that gap, so the same equipment delivers less cooling
exactly when you need it most.

At that point air speed over the birds is what's left doing useful work.

**In the report:** a forecast high at or above 88° *combined with* a dew point at
or above 72° triggers the cool-cell warning. Either alone isn't remarkable; it's
the pair that matters.

### Why 95° gets its own line

Above roughly the mid-90s, water consumption spikes and a restriction that would
have been survivable at 85° becomes an emergency in hours. The risk moves from
the ventilation system to the water system.

---

## What the forecast can't tell you

The report is predicting *outside* conditions and inferring pressure on the
house. It does not know:

- how old your birds are, or what the target is this week
- whether a fan, thermostat, or cool-cell pump is already failing
- whether the litter is wet or the inlets are set right
- what the propane level is before a cold snap

Which is the whole point of the Sensaphone readings sitting next to it in the
same text. The forecast tells you what's coming; the readings tell you how the
house is actually handling it. A normal reading under a hard forecast means the
equipment is working. A drifting reading under a mild forecast means something
is broken — and that's the more urgent of the two.

---

## Source

Forecast comes from [Open-Meteo](https://open-meteo.com) — free, no API key, no
account. Coordinates are hard-coded to 1875 Goshen Road, Carthage MS and can be
overridden with `FARM_LAT` / `FARM_LON` environment variables.

If the forecast call fails, the script logs it and sends the report anyway
without the weather block. A weather outage should never cost you the readings.
