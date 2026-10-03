#include <stdio.h>
#include <time.h>

int main(void) {
    int year, month, day, hour, minute, second;
    while (scanf("%d %d %d %d %d %d", &year, &month, &day, &hour, &minute, &second) == 6) {
        struct tm value = {0};
        value.tm_year = year - 1900;
        value.tm_mon = month - 1;
        value.tm_mday = day;
        value.tm_hour = hour;
        value.tm_min = minute;
        value.tm_sec = second;
        value.tm_isdst = -1;
        time_t result = mktime(&value);
        printf("%lld\n", (long long)result);
    }
    return ferror(stdin) || ferror(stdout) ? 1 : 0;
}
