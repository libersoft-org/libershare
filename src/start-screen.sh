#!/bin/sh

screen -dmS libershare bash -c '
while true; do
 bun libershare.js || exit 1
done
'
