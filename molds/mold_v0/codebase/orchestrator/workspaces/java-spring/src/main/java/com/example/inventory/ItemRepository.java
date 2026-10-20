package com.example.inventory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Repository;

/** In-memory store. Data is lost on restart. */
@Repository
public class ItemRepository {
    private final Map<Long, Item> items = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();

    public List<Item> findAll() {
        return new ArrayList<>(items.values());
    }

    public Optional<Item> findById(long id) {
        return Optional.ofNullable(items.get(id));
    }

    public Item save(Item item) {
        Item stored = item.id() == null ? item.withId(ids.incrementAndGet()) : item;
        items.put(stored.id(), stored);
        return stored;
    }

    public void deleteById(long id) {
        items.remove(id);
    }
}
