#!/bin/sh

screen -dmS lish-backend bash -c ". ./colors.sh; trap bash SIGINT; (./start-dev.sh ; bash);"
