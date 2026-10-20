import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet } from "react-native";
import { HabitsScreen } from "./src/screens/HabitsScreen";

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <HabitsScreen />
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
});
