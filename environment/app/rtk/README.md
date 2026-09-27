# Summit network: session notes

Maintained by the deformation group. The tool reads everything from the network's caster; there
is no copy of the observations on this box.

## Caster

TCP, at `CASTER_HOST` and `CASTER_PORT` from the environment. `CASTER_HOST` may be a host name or
an address. Client and caster both speak in ASCII text, a line per command or record, each line
terminated by LF.

The first line the caster writes on a new connection is `CASTER RTK2 <network> limit=<n>`.

| command | answer |
|---|---|
| `STATIONS` | one `STA <id> <role> <receiver> <x> <y> <z>` line per station, then `END` |
| `SUB <station> <cursor>` | the station's session from the cursor on: each epoch is an `EPOCH` line followed by its `OBS` lines, and `END` follows the last epoch. The cursor for the first epoch is `-` |
| `QUIT` | `BYE`, then the caster closes |

- `n` in the greeting is the number of epochs one connection carries, over all its
  subscriptions together. Where the next epoch would be number `n + 1`, the caster sends
  `CUT <cursor>` instead and closes. `SUB` with the same station and that cursor, on a new
  connection, carries on from the epoch that was held back. Cursors stay good while the caster
  runs.
- `ERR <text>` answers an unknown command, station or cursor.
- A connection that sends nothing for 10 seconds is closed without a word.

## Stations

- `role` is `REF` for the reference station, on the old lava plain below the edifice, and
  `ROVER` for the stations on the volcano.
- `x y z` are metres, Earth-fixed, WGS84. For `REF` they are the surveyed position of the
  monument. For a rover they are where its monument was at the last campaign, good to a few
  metres.
- `receiver` is `KESTREL-5` or `TARN-2`. The two kinds are spread over the network.

## Epochs

`EPOCH <k> <t>`: `k` numbers the epochs of the session, one second apart; `t` is seconds of the
GPS week. When the radio link drops epochs, those epochs are missing from that station's
stream. The receiver itself keeps tracking through a dropout.

`OBS <sat> <x> <y> <z> <C1> <L1> <C2> <L2> <flags>`, one line per satellite the station
tracked:

- `x y z` is the satellite's position for that epoch, same frame, metres. The range inside
  every measurement of the epoch, at every station, is the straight line from that point to the
  station's monument: signal travel time, Earth rotation and antenna offsets are already taken
  care of.
- `C1`, `C2` are code ranges in metres and `L1`, `L2` carrier phase in cycles, on 1575.42 and
  1227.60 MHz. Speed of light 299792458 m/s.
- `flags` is what the receiver reports: 1 means it lost lock on L1 since the previous epoch, 2
  the same for L2, 3 both.
- Receiver and satellite clocks wander by up to about a millisecond; a clock error is in code
  and phase alike.
- The station firmware removes the neutral atmosphere from every measurement using the site's
  met sensor. The ionosphere stays in: it delays code and advances phase, on L2 by (1575.42 /
  1227.60)^2 times what it does on L1. Along any line of sight the L1 ionospheric delay at a rover
  differs from the delay at the reference station by up to a few decimetres, and during one
  session that difference does not change.
- Measurement noise is white. Code scatters by a few decimetres and phase by one to two
  millimetres, whatever the elevation.

A session is 60 to 90 epochs long. There are up to seven rovers, and a station tracks up to
15 satellites.

## Baselines

A rover's baseline is its monument's position minus the reference monument's, given as east,
north and up in millimetres: the local frame at the reference monument, on the WGS84 ellipsoid
(a = 6378137 m, f = 1/298.257223563) with geodetic latitude.
