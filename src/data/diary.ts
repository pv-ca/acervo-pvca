import { fetchDiary } from "../../scripts/lib/letterboxd-diary.mjs";
import { catalog } from "./catalog";

// Fetched once per build; the scheduled Pages workflow keeps it current.
export const diary = await fetchDiary(catalog);
