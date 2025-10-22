#!/bin/sh

screen -dmS libershare bash -c ". ./colors.sh; trap bash SIGINT; (./start-dev.sh ; bash);"
