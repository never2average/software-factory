package com.example.inventory;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;

public record Item(Long id, @NotBlank String sku, @NotBlank String name, @Min(0) int quantity) {
    public Item withId(Long newId) {
        return new Item(newId, sku, name, quantity);
    }

    public Item withQuantity(int newQuantity) {
        return new Item(id, sku, name, newQuantity);
    }
}
