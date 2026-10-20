import { useState } from "react";
import { Button, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { habitStore, type Habit } from "../store/habits";

const today = () => new Date().toISOString().slice(0, 10);

export function HabitsScreen() {
  const [habits, setHabits] = useState<Habit[]>(habitStore.list());
  const [name, setName] = useState("");
  const refresh = () => setHabits([...habitStore.list()]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Habits</Text>
      <View style={styles.row}>
        <TextInput style={styles.input} placeholder="New habit" value={name} onChangeText={setName} />
        <Button
          title="Add"
          onPress={() => {
            if (!name.trim()) return;
            habitStore.add(name);
            setName("");
            refresh();
          }}
        />
      </View>
      <FlatList
        data={habits}
        keyExtractor={(h) => h.id}
        renderItem={({ item }) => {
          const done = item.completions.includes(today());
          return (
            <Pressable style={styles.habit} onPress={() => { habitStore.toggle(item.id, today()); refresh(); }}>
              <Text style={[styles.name, done && styles.done]}>{item.name}</Text>
              <Text>{habitStore.streak(item.id, today())} day streak</Text>
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text>No habits yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 28, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 8 },
  habit: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  name: { fontSize: 18 },
  done: { textDecorationLine: "line-through", color: "#888" },
});
