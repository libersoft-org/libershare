#!/bin/sh

[ ! -d "./node_modules/" ] && bun i
screen -dmS libershare bun --watch libershare.js
