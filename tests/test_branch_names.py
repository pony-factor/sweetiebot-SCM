import json
import unittest

import branch_names


class BranchNamePackTests(unittest.TestCase):
    def test_builtin_catalog_excludes_known_scrape_artifacts(self):
        catalog = branch_names.load_catalog()
        names = {
            name
            for pack in catalog["packs"]
            for name in pack["names"]
        }
        for noisy in (
            "executive-producer-story-editornicole-dubuc",
            "knowledgeable-shopperwhite-lightning",
            "cruise-pony-3forceful-parent-ponysun-cloche",
            "alicorn-royal-guards",
            "game-playin-schoolponybutton-mash",
            "janitor-ponyclean-sweep",
            "the-tenth-doctor-doctor-whooves-3",
            "wavy-haired-pegasusthe-tenth-doctor-doctor-whooves-3",
        ):
            self.assertNotIn(noisy, names)

    def test_builtin_catalog_has_unique_names_within_each_pack(self):
        catalog = branch_names.load_catalog()
        for pack in catalog["packs"]:
            self.assertEqual(
                len(pack["names"]),
                len(set(pack["names"])),
                f"{pack['id']} contains duplicate branch-name slugs",
            )

    def test_tamers_and_chrysalis_full_names(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}
        all_names = {
            name
            for pack in catalog["packs"]
            for name in pack["names"]
        }

        self.assertIn("queen-chrysalis", packs["g4-creatures"]["names"])
        self.assertNotIn("chrysalis", packs["g4-creatures"]["names"])
        for name in ("fractured", "dazzle-feather", "starsong"):
            self.assertIn(name, packs["tamers12345"]["names"])
        self.assertNotIn("lauren-faust", all_names)

    def test_g5_remaining_is_comprehensive_without_changing_tamers(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}
        remaining = set(packs["g5-remaining"]["names"])

        self.assertEqual(len(packs["g5-remaining"]["names"]), 193)
        for name in (
            "arpeggia",
            "fretlock",
            "jam-donut",
            "sparky-sparkeroni",
            "opaline-arcana",
            "queen-haven",
            "alphabittle-blossomforth",
            "comet",
            "comet-tail",
            "leaf-dragon",
            "violette-rainbow",
            "tracy-tailspin",
            "princess-anemone",
            "sky-scoop",
            "goldie-fortune",
            "scout-kindheart",
        ):
            self.assertIn(name, remaining)

        self.assertEqual(
            packs["tamers12345"]["names"],
            [
                "flawless-sparklemoon",
                "fractured",
                "care-package",
                "future-soarin",
                "friendship",
                "arinos",
                "dazzle-feather",
                "skye-silver",
                "starsong",
                "parcelcore",
                "professor-kirin",
                "bobby-moonbeam",
                "professor-majorchord",
                "astro-novalite",
            ],
        )
        self.assertNotIn("dazzle-feather", remaining)
        self.assertNotIn("skye-silver", remaining)
        self.assertTrue(
            remaining.isdisjoint(packs["tamers12345"]["names"]),
            "G5 remaining must not duplicate Tamers12345 branch-name slugs",
        )

        g4_names = {
            name
            for pack_id in ("g4-mares", "g4-stallions", "g4-fillies", "g4-colts", "g4-creatures")
            for name in packs[pack_id]["names"]
        }
        for name in (
            "alphabittle-blossomforth",
            "argyle-starshine",
            "jazz-hooves",
            "phyllis-cloverleaf",
            "posey-bloom",
            "queen-haven",
            "sprout-cloverleaf",
            "thunder-flap",
            "zoom-zephyrwing",
        ):
            self.assertNotIn(name, g4_names)

    def test_g4_stallions_use_full_wacky_hair_day_and_spray_name(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}
        names = packs["g4-stallions"]["names"]

        self.assertIn("wacky-hair-day-and-spray", names)
        self.assertNotIn("day-and-spray", names)

    def test_pony_life_names_are_separate_from_g4_packs(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}
        pony_life_names = {
            "april-shower",
            "bone-pony",
            "butterscotch",
            "buttershy",
            "cha-cha",
            "chamomilia",
            "cotton-candy",
            "cottony-sweet",
            "curtain-call",
            "derek",
            "dishwater-slog",
            "fizzleshake",
            "gardenia-glow",
            "grey-skies",
            "gusty",
            "hothoof",
            "jupiter",
            "karen-caring",
            "lilith",
            "lime-time",
            "matt",
            "natalie",
            "noctula",
            "octavio-pie",
            "pineapple-salsa",
            "potion-nova",
            "pulverizer",
            "rainbow-hip",
            "rainstorm",
            "saddle-bags",
            "saguaro",
            "skull-pony",
            "smallfry",
            "spring-parade",
            "surfs-up",
            "taffy",
            "teacup",
            "tiptop",
            "zesty",
        }

        self.assertTrue(pony_life_names.issubset(packs["pony-life"]["names"]))

        g4_names = {
            name
            for pack in catalog["packs"]
            if pack["id"].startswith("g4-")
            for name in pack["names"]
        }
        self.assertTrue(pony_life_names.isdisjoint(g4_names))

    def test_idw_comics_pack_covers_named_comic_roster(self):
        catalog = branch_names.load_catalog()
        packs = {pack["id"]: pack for pack in catalog["packs"]}
        names = packs["idw-comics"]["names"]

        self.assertEqual(len(names), 301)
        for name in (
            "acacia-pie",
            "captain-hoofbeard",
            "emperor-incitatus",
            "humdrum",
            "radiant-hope",
            "shadow-lock",
            "sweet-cream-scoops",
            "winter-comet",
        ):
            self.assertIn(name, names)
        self.assertFalse(any("unnamed" in name for name in names))

    def test_imports_accept_single_pack_array_or_catalog_object(self):
        pack = {"id": "friends", "label": "Friends", "names": ["one", "two"]}
        self.assertEqual(
            branch_names.parse_imported_packs(json.dumps(pack))[0]["id"],
            "friends",
        )
        self.assertEqual(
            branch_names.parse_imported_packs(json.dumps([pack]))[0]["id"],
            "friends",
        )
        self.assertEqual(
            branch_names.parse_imported_packs(json.dumps({"packs": [pack]}))[0]["id"],
            "friends",
        )

    def test_runtime_settings_merge_packs_and_custom_names(self):
        settings = {
            "branchNameDisabledPacks": "g4-creatures",
            "branchCustomNames": "my-oc,second-oc",
            "branchNameImports": '[{"id":"friends","label":"Friends","names":["other-oc"]}]',
        }

        runtime = branch_names.resolve_runtime_settings(settings)

        self.assertIn("g4-creatures", runtime["branchNameDisabledPacks"])
        self.assertEqual(runtime["branchCustomNames"], ["my-oc", "second-oc"])
        self.assertIn(
            "friends",
            {pack["id"] for pack in runtime["branchNamePacks"]},
        )
        self.assertNotIn("branchNameImports", runtime)

    def test_explicit_enabled_pack_snapshot_keeps_new_packs_off(self):
        settings = {
            "branchNameDisabledPacks": "",
            "branchNameEnabledPacks": "g4-mares,g4-stallions",
            "branchCustomNames": "",
            "branchNameImports": "[]",
        }

        runtime = branch_names.resolve_runtime_settings(settings)

        self.assertNotIn("g4-mares", runtime["branchNameDisabledPacks"])
        self.assertNotIn("g4-stallions", runtime["branchNameDisabledPacks"])
        self.assertIn("g4-creatures", runtime["branchNameDisabledPacks"])
        self.assertNotIn("branchNameEnabledPacks", runtime)

    def test_rejects_conflicting_import_id(self):
        with self.assertRaisesRegex(ValueError, "conflicts with a built-in pack"):
            branch_names.merge_catalog(
                branch_names.load_catalog(),
                branch_names.parse_imported_packs(
                    '[{"id":"g4-mares","label":"Conflict","names":["other"]}]'
                ),
            )


if __name__ == "__main__":
    unittest.main()
