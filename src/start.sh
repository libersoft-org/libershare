#!/bin/sh

[ ! -d "./node_modules/" ] && bun i
bun libershare.js $1
