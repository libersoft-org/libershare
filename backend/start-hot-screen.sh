#!/bin/sh

ARGS="$*"
screen -dmS lish-backend bash -c ". ./colors.sh; trap bash SIGINT; (./start-hot.sh $ARGS ; bash);"
