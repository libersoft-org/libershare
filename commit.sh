#!/usr/bin/env bash

REPO="libershare.git"
NAME="LiberSoft"
BRANCH="main"
EMAIL="info@libersoft.org"
USER="libersoft-org"
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

cd "$ROOT"

PASS=$(<"$ROOT/.secret_git")

if [ ! -d "./.git/" ]; then
	git init
	git config --global --add safe.directory '*'
	git remote add origin https://$USER:$PASS@github.com/$USER/$REPO
else
	git remote set-url origin https://$USER:$PASS@github.com/$USER/$REPO
fi

bun i -g prettier

git config user.name "$NAME"
git config user.email "$EMAIL"

if ! "$ROOT/format.sh" --changed; then
	echo "commit.sh: formatting changed files failed - committing without a fresh format pass"
fi

git status
git add .

src/tools/check-source-hygiene.sh --added

git status

if [ "$#" -eq 0 ]; then
	echo "Generating commit message using Claude Code..."
	# echo "Generating commit message using GitHub Copilot..."
	#
	# Three things went wrong together and put an error message in the history, twice.
	#
	# The whole diff went into the prompt with no bound, so a large change asked for ~3.5 million
	# tokens against a 200k limit. The generator then printed "Prompt is too long ..." ON STDOUT and
	# exited 1 - and `2>/dev/null` catches nothing, because the failure is not on stderr. The status
	# was invisible too: `$?` after a pipeline is the LAST command's, which was `head`. What was left
	# was a check for empty and for "No changes", and an error sentence is neither.
	#
	# So: bound what is sent, read the generator's OWN status, and refuse a subject that is not one.
	DIFF_LIMIT=200000
	PROMPT_FILE=$(mktemp)
	{
		echo "Write exactly one Git commit subject."
		echo "Max 250 characters."
		echo "One line only."
		echo "No prefix."
		echo "No markdown."
		echo "No bullets."
		echo "No explanation."
		echo "No status narration."
		echo "If there are no changes, write exactly: No changes"
		echo
		echo "GIT STATUS:"
		git status --short
		echo
		echo "STAGED DIFF STAT:"
		git diff --cached --stat
		echo
		echo "STAGED DIFF (truncated at $DIFF_LIMIT bytes):"
		git diff --cached --unified=0 | head -c "$DIFF_LIMIT"
		echo
		echo "UNSTAGED DIFF STAT:"
		git diff --stat
		echo
		echo "UNSTAGED DIFF (truncated at $DIFF_LIMIT bytes):"
		git diff --unified=0 | head -c "$DIFF_LIMIT"
	} >"$PROMPT_FILE"
	RAW_MSG=$(claude -p --model haiku --output-format text --no-session-persistence \
		--system-prompt "You output exactly one line of plain text and nothing else. Never use markdown, code fences, backticks, bullets, headings or commentary." \
		--disallowedTools Bash Read Glob Grep Edit Write WebFetch WebSearch Task TodoWrite <"$PROMPT_FILE" 2>/dev/null)
	GEN_STATUS=$?
	rm -f "$PROMPT_FILE"
	COMMIT_MSG=$(printf '%s\n' "$RAW_MSG" | sed -e 's/`//g' -e '/^[[:space:]]*$/d' | head -n 1)
	# Previous generator (GitHub Copilot CLI), kept for reference:
	# } | copilot -s --no-ask-user 2>/dev/null)
	# The generator's own status is the guard that matters, and it is sufficient: the failure was
	# reproduced and it exits 1. The length check below is a weak backstop, not a classifier - the
	# message that reached the history was about 290 characters and would be caught, but a shorter
	# error sentence fits under the limit and would not. Do not read it as a second line of defence.
	if [ "$GEN_STATUS" -ne 0 ]; then
		printf '\033[31mERROR:\033[0m The commit message generator failed (exit %s). Its output was:\n%s\n' "$GEN_STATUS" "$RAW_MSG"
		echo "Usage: $0 \"[COMMIT MESSAGE]\""
		exit 1
	fi
	if [ -z "$COMMIT_MSG" ] || [ "$COMMIT_MSG" = "No changes" ] || [ "${#COMMIT_MSG}" -gt 250 ]; then
		printf '\033[31mERROR:\033[0m Failed to generate a usable commit message. Got: %s\n' "$COMMIT_MSG"
		echo "Usage: $0 \"[COMMIT MESSAGE]\""
		exit 1
	fi
	COMMIT_MSG=$(echo "$COMMIT_MSG" | sed 's/"//g' | sed "s/'//g")
	printf '\033[33mGENERATED COMMIT MESSAGE:\033[0m %s\n' "$COMMIT_MSG"
	COMMIT_MESSAGE="$COMMIT_MSG"
else
	COMMIT_MESSAGE=$(echo "$1" | sed 's/"//g' | sed "s/'//g")
fi

git commit -m "$COMMIT_MESSAGE"
git push
git status
