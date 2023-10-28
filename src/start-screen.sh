#!/bin/sh

[ ! -d "./node_modules/" ] && bun i
screen -dmS libershare bash -c '
while true; do
 bun libershare.js || exit 1
done
'
