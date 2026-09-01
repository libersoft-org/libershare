#!/bin/bash
# Git daily stats — lines added / removed / net per day + total summary

usage() {
	echo "usage: git-stats.sh [day-count]" >&2
	exit 2
}

if (($# > 1)); then
	usage
fi

day_count="${1:-}"
if [[ -n "$day_count" && ! "$day_count" =~ ^[1-9][0-9]*$ ]]; then
	echo "git-stats: day-count must be a positive integer" >&2
	usage
fi

# Translate a day count into a commit count before touching any diff. Walking dates alone
# costs milliseconds, so restricting the traversal that follows is cheaper than filtering
# its output, and `--since` cannot be used here: it reads the committer date while every
# row on this table is grouped by the author date.
#
# Both passes below run git's default traversal, so a commit sits at the same position in
# each: bounding the diff pass at the position of the oldest in-window commit is guaranteed
# to carry every one of them along. No date ordering is asked for, because none is offered —
# `--author-date-order` yields to topology, so merges make dates jump backwards and a day
# can reappear after a later one. The window is a date test, and the table is sorted in awk.
# Settle both "nothing to report" cases up front, or each pass below repeats git's own fatal
# on stderr and the table still prints its header over an empty body.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
	echo "git-stats: not a git repository" >&2
	exit 1
fi
if [[ -z "$(git log --format='%H' --max-count=1 2>/dev/null)" ]]; then
	echo "git-stats: no commits" >&2
	exit 1
fi

log_args=()
cutoff=""
if [[ -n "$day_count" ]]; then
	# The day_count-th distinct date, newest first — every commit authored on or after it belongs.
	# Empty means the history holds fewer active days than were asked for: report all of them.
	cutoff="$(git log --format='%ad' --date=short | sort -ru | sed -n "${day_count}p")"
	if [[ -n "$cutoff" ]]; then
		commit_limit="$(git log --format='%ad' --date=short |
			awk -v cutoff="$cutoff" '$0 >= cutoff { last = NR } END { print last + 0 }')"
		log_args+=(--max-count="$commit_limit")
	fi
fi

if [[ -t 1 ]]; then
	RED=$'\033[31m'
	GREEN=$'\033[32m'
	NET_PLUS=$'\033[93m'
	NET_MINUS=$'\033[38;5;130m'
	RESET=$'\033[0m'
else
	RED=""
	GREEN=""
	NET_PLUS=""
	NET_MINUS=""
	RESET=""
fi

echo ""
echo "=== Git Daily Stats ==="
echo ""

printf "%-12s %8s %8s %8s %8s\n" "Date" "Commits" "Removed" "Added" "Net"
printf "%-12s %8s %8s %8s %8s\n" "----------" "-------" "------" "------" "------"

# One traversal for every day at once. Asking git per day cost three full history walks per
# row, so the work grew with days times commits instead of with commits. A day is summed
# under its own key rather than accumulated until the date changes, because the log arrives
# with dates interleaved: streaming would file one day under several rows.
git log "${log_args[@]}" --format=$'\x01%ad' --date=short --numstat |
	awk -v cutoff="$cutoff" -v red="$RED" -v green="$GREEN" -v net_plus="$NET_PLUS" \
		-v net_minus="$NET_MINUS" -v reset="$RESET" '
		substr($0, 1, 1) == "\001" {
			day = substr($0, 2)
			# The traversal is bounded by position, not by date, so commits from before the
			# window ride along at the tail — drop them and the numstat lines they own.
			if (cutoff != "" && day < cutoff) {
				day = ""
				next
			}
			commits[day] += 1
			next
		}
		# Binary files report "-" for both counts and contribute no line total.
		day != "" && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
			added[day] += $1
			removed[day] += $2
		}
		END {
			for (d in commits) dates[++active_days] = d
			# Insertion sort — the table is one row per active day, so this stays well under
			# the cost of the traversal that filled it, and it needs no awk beyond POSIX.
			for (i = 2; i <= active_days; i++) {
				key = dates[i]
				for (j = i - 1; j >= 1 && dates[j] > key; j--) dates[j + 1] = dates[j]
				dates[j + 1] = key
			}
			for (i = 1; i <= active_days; i++) {
				d = dates[i]
				# A merge contributes a commit but no numstat, so a merge-only day never
				# assigns these — +0 turns the empty string back into a printable zero.
				day_added = added[d] + 0
				day_removed = removed[d] + 0
				net = day_added - day_removed
				total_commits += commits[d]
				total_added += day_added
				total_removed += day_removed
				# Colour around the padded field, never inside it: the escape bytes have no
				# width on screen but printf counts them, which would shorten every column.
				printf "%-12s %8d %s%8s%s %s%8s%s %s%8s%s\n", \
					d, commits[d], \
					red, "-" day_removed, reset, \
					green, "+" day_added, reset, \
					net < 0 ? net_minus : net_plus, sprintf("%+d", net), reset
			}
			total_net = total_added - total_removed
			printf "\n=== Total Summary ===\n\n"
			printf "Removed: %s%8s%s lines\n", red, "-" total_removed, reset
			printf "Added:   %s%8s%s lines\n", green, "+" total_added, reset
			printf "Net:     %s%8s%s lines\n", \
				total_net < 0 ? net_minus : net_plus, sprintf("%+d", total_net), reset
			printf "Commits: %8d\n", total_commits
			printf "Active days: %4d\n", active_days
			printf "\n"
		}
	'
