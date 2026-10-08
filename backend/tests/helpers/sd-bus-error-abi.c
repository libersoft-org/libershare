#include <stddef.h>
#include <stdio.h>
#include <systemd/sd-bus.h>

_Static_assert(sizeof(void *) == 8, "64-bit pointers required");
_Static_assert(sizeof(sd_bus_error) == 24, "Unexpected sd_bus_error size");
_Static_assert(_Alignof(sd_bus_error) == 8, "Unexpected sd_bus_error alignment");
_Static_assert(offsetof(sd_bus_error, name) == 0, "Unexpected name offset");
_Static_assert(offsetof(sd_bus_error, message) == 8, "Unexpected message offset");
_Static_assert(offsetof(sd_bus_error, _need_free) == 16, "Unexpected ownership offset");
_Static_assert(sizeof(((sd_bus_error *)0)->_need_free) == 4, "Unexpected ownership size");

int main(void)
{
    printf("{\"pointerSize\":%zu,\"size\":%zu,\"alignment\":%zu,"
           "\"nameOffset\":%zu,\"messageOffset\":%zu,\"needFreeOffset\":%zu,\"needFreeSize\":%zu}\n",
           sizeof(void *), sizeof(sd_bus_error), _Alignof(sd_bus_error),
           offsetof(sd_bus_error, name), offsetof(sd_bus_error, message),
           offsetof(sd_bus_error, _need_free), sizeof(((sd_bus_error *)0)->_need_free));
    return 0;
}
