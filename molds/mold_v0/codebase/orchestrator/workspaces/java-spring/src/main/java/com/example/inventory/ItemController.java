package com.example.inventory;

import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/items")
public class ItemController {
    private final ItemRepository repository;

    public ItemController(ItemRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public List<Item> list() {
        return repository.findAll();
    }

    @GetMapping("/{id}")
    public Item get(@PathVariable long id) {
        return repository.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Item create(@Valid @RequestBody Item item) {
        return repository.save(item.withId(null));
    }

    @PatchMapping("/{id}/quantity")
    public Item adjust(@PathVariable long id, @RequestParam int delta) {
        Item item = get(id);
        int next = item.quantity() + delta;
        if (next < 0) throw new ResponseStatusException(HttpStatus.CONFLICT, "Insufficient stock");
        return repository.save(item.withQuantity(next));
    }
}
