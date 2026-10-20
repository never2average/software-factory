# sensor-aggregator

Small C++17 tool that ingests sensor readings (`sensor_id,timestamp_ms,value` lines on stdin) and prints per-sensor
summaries. Built with CMake; no third-party libraries yet.

```
cmake -S . -B build && cmake --build build
./build/sensor-aggregator < readings.csv
ctest --test-dir build
```

Readings are kept in memory (`Aggregator`) and are not persisted.
