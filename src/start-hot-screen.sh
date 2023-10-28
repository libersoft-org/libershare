#!/bin/sh

[ ! -d "./node_modules/" ] && bun i
screen -dmS libershare bun --hot libershare.js
