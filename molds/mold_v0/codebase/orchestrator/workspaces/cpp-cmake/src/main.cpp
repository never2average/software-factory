// Reads "sensor_id,timestamp_ms,value" lines from stdin and prints a per-sensor summary.
#include <iostream>
#include <string>

#include "aggregator.hpp"

int main() {
    Aggregator agg;
    std::string line;
    std::size_t bad = 0;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && !agg.ingest_line(line)) ++bad;
    }
    for (const auto& id : agg.sensors()) {
        auto s = agg.summary(id);
        std::cout << id << ": n=" << s->count << " min=" << s->min << " max=" << s->max << " mean=" << s->mean << "\n";
    }
    if (bad) std::cerr << bad << " malformed line(s) skipped\n";
    return 0;
}
