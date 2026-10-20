#include <cassert>
#include <cmath>

#include "aggregator.hpp"

int main() {
    Aggregator agg;
    assert(agg.ingest_line("t1,1000,20.5"));
    assert(agg.ingest_line("t1,2000,22.5"));
    assert(!agg.ingest_line("broken"));
    auto s = agg.summary("t1");
    assert(s && s->count == 2 && std::fabs(s->mean - 21.5) < 1e-9);
    assert(!agg.summary("missing"));
    return 0;
}
