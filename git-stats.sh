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
log_args=(--author-date-order --reverse)
if [[ -n "$day_count" ]]; then
	commit_limit="$(git log --author-date-order --format='%ad' --date=short |
		awk -v days="$day_count" '
			$0 != last { seen += 1; last = $0 }
			seen > days { exit }
			{ count += 1 }
			END { print count + 0 }
		')"
	if ((commit_limit == 0)); then
		echo "git-stats: no commits in the last $day_count active days" >&2
		exit 1
	fi
	log_args+=(--max-count="$commit_limit")
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
# row, so the work grew with days times commits instead of with commits. Ordering by author
# timestamp is what lets each day print the moment the next one starts, with no sort holding
# the whole table back: it is the same timestamp the rows are grouped by.
git log "${log_args[@]}" --format=$'\x01%ad' --date=short --numstat |
	awk -v red="$RED" -v green="$GREEN" -v net_plus="$NET_PLUS" \
		-v net_minus="$NET_MINUS" -v reset="$RESET" '
		function flush(net) {
			if (day == "") return
			net = added - removed
			total_commits += commits
			total_added += added
			total_removed += removed
			active_days += 1
			# Colour around the padded field, never inside it: the escape bytes have no
			# width on screen but printf counts them, which would shorten every column.
			printf "%-12s %8d %s%8s%s %s%8s%s %s%8s%s\n", \
				day, commits, \
				red, "-" removed, reset, \
				green, "+" added, reset, \
				net < 0 ? net_minus : net_plus, sprintf("%+d", net), reset
			fflush()
		}
		substr($0, 1, 1) == "\001" {
			if (substr($0, 2) != day) {
				flush()
				day = substr($0, 2)
				commits = 0
				added = 0
				removed = 0
			}
			commits += 1
			next
		}
		# Binary files report "-" for both counts and contribute no line total.
		$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
			added += $1
			removed += $2
		}
		END {
			flush()
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
