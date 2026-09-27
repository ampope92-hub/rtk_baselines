#!/bin/bash
# Oracle. Puts the reference tool in place and checks that node parses it.
#
# main.js reads every station's session through the caster (following CUT cursors across
# connections), forms double differences against the reference station and a pivot satellite
# seen in every epoch (fewest arc breaks, then highest), and solves each rover in two passes: a
# float least squares for the baseline, one steady ionospheric offset per satellite and the L1/L2 ambiguities
# of every arc, then integer least squares on those ambiguities (LAMBDA: decorrelation, then a
# shrinking search) and the baseline again with the integers held. Arcs are cut on the loss-of-lock
# bits and on jumps in the geometry-free phase or the wide lane, since the TARN-2 receivers do
# not always raise the bits.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$HERE/main.js" /app/rtk/main.js
cd /app/rtk
node --check main.js
