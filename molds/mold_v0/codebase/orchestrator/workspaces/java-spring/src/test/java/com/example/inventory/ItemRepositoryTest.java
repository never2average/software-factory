package com.example.inventory;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import org.junit.jupiter.api.Test;

class ItemRepositoryTest {
    @Test
    void savesAndAssignsIds() {
        ItemRepository repo = new ItemRepository();
        Item saved = repo.save(new Item(null, "SKU-1", "Widget", 5));
        assertNotNull(saved.id());
        assertEquals(1, repo.findAll().size());
    }
}
