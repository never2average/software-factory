#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

struct Reading {
    std::string sensor_id;
    long long timestamp_ms;
    double value;
};

struct Summary {
    std::size_t count = 0;
    double min = 0, max = 0, mean = 0;
};

// Keeps readings in memory, grouped by sensor. Nothing is persisted.
class Aggregator {
public:
    // Parses "sensor_id,timestamp_ms,value" lines; returns false on malformed input.
    bool ingest_line(const std::string& line);
    void add(const Reading& r);
    std::optional<Summary> summary(const std::string& sensor_id) const;
    std::vector<std::string> sensors() const;

private:
    std::map<std::string, std::vector<Reading>> by_sensor_;
};
