cmake_minimum_required(VERSION 3.20)
project(sensor_aggregator LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(aggregator src/aggregator.cpp)
target_include_directories(aggregator PUBLIC include)

add_executable(sensor-aggregator src/main.cpp)
target_link_libraries(sensor-aggregator PRIVATE aggregator)

enable_testing()
add_executable(aggregator_test tests/aggregator_test.cpp)
target_link_libraries(aggregator_test PRIVATE aggregator)
add_test(NAME aggregator_test COMMAND aggregator_test)
