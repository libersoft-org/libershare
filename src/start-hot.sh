#!/bin/sh

[ ! -d "./node_modules/" ] && bun i
bun --hot libershare.js
