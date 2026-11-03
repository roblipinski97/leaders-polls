"""Write config/governments.yaml: who headed the government, and from which party, since 1985.

Sources
  * data/external/parlgov_pm_cabinets.csv  ParlGov cabinets (Döring, Huber & Manow, parlgov.org),
    extracted from github.com/hdigital/parlgov-snippets (cabinet-type/view_cabinet.csv,
    commit 246f250, data to Dec 2020): one row per cabinet, the prime minister's party.
  * MANUAL below: cabinets after 2020, and Serbia, Moldova and Montenegro (not in ParlGov),
    from the Wikipedia lists of heads of government. Periods from the first incumbent in
    config/countries.yaml onwards come from that file instead, so they are not repeated here.

    python tools/make_governments.py
"""
import csv
import pathlib
import re

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
ISO3 = {"AUT": "AT", "BGR": "BG", "CZE": "CZ", "DEU": "DE", "DNK": "DK", "ESP": "ES", "EST": "EE",
        "FIN": "FI", "FRA": "FR", "GBR": "GB", "GRC": "GR", "HRV": "HR", "HUN": "HU", "IRL": "IE",
        "ISL": "IS", "ITA": "IT", "LTU": "LT", "LUX": "LU", "LVA": "LV", "MLT": "MT", "NLD": "NL",
        "NOR": "NO", "POL": "PL", "PRT": "PT", "ROU": "RO", "SVK": "SK", "SVN": "SI", "SWE": "SE"}

# ParlGov party -> extra names to look for among the poll-table parties
EXTRA_MATCH = {
    "Union for a Popular Movement | The Republicans": ["Union for a Popular Movement", "The Republicans (France)", "UMP", "LR"],
    "Rally for the Republic": ["Rally for the Republic", "RPR"],
    "Coalition for Bulgaria | Democratic Left": ["Bulgarian Socialist Party", "Coalition for Bulgaria", "BSP"],
    "Citizens for European Development of Bulgaria": ["GERB"],
    "Democratic | Freedom | Union": ["Democratic Union (Poland)", "Freedom Union (Poland)", "UD", "UW"],
    "Go Italy -- The People of Freedom": ["Forza Italia", "The People of Freedom", "Forza Italia (2013)", "FI", "PdL"],
    "Democratic Liberal Party": ["Democratic Liberal Party (Romania)", "PD-L", "PDL"],
    "Social Democratic Party": ["Social Democratic Party (Romania)", "PSD"],
    "National Liberal Party": ["National Liberal Party (Romania)", "PNL"],
    "Christian Democratic Union | Christian Social Union": ["CDU/CSU", "Union", "CDU"],
    "Social Democratic Party of Germany": ["SPD"],
    "Labour Party": ["Labour Party (UK)", "Labour Party (Norway)", "Labour Party (Malta)", "Lab", "Ap", "PL"],
    "Conservative Party": ["Conservative Party (UK)", "Con"],
    "Law and Justice": ["Law and Justice (Poland)", "PiS", "United Right (Poland)"],
    "Civic Platform": ["Civic Platform", "Civic Coalition (Poland)", "PO", "KO"],
    "Democratic Left Alliance": ["Democratic Left Alliance (Poland)", "SLD"],
    "Social Democrats": ["Social Democrats (Denmark)", "A"],
    "Liberals": ["Venstre (Denmark)", "V"],
    "Smer-Social Democracy": ["Direction – Social Democracy", "Smer"],
    "Ordinary People and Independent Personalities": ["Slovakia (political party)", "OĽaNO", "Ordinary People and Independent Personalities"],
    "Fidesz -- Hungarian Civic Union": ["Fidesz", "Fidesz–KDNP"],
    "Hungarian Socialist Party": ["MSZP"],
    "Croatian Democratic Union": ["HDZ"],
    "Rally for the Republic": ["Union for a Popular Movement", "RPR"],
    "La République En Marche!": ["Ensemble (political coalition)", "LREM", "ENS"],
    "Liberal Party": ["Venstre (Denmark)", "V"],
    "Social Democrats": ["Swedish Social Democratic Party", "Social Democrats (Denmark)", "S", "A"],
    "Unity": ["New Unity", "JV", "Unity (Latvia)"],
    "Lithuanian Peasant Union": ["Lithuanian Farmers and Greens Union", "LVŽS"],
    "People's Alliance-Party": ["PP", "People's Party (Spain)"],
    "Centre Left": ["Democratic Party (Italy)", "The Olive Tree (Italy)", "The Union (Italy)"],
    "Ordinary People and Independent Personalities": ["Ordinary People (Slovakia)", "OĽaNO"],
    "Ordinary People and Independent": ["Ordinary People (Slovakia)", "OĽaNO"],
    "United List -- Social Democrats": ["Social Democrats (Slovenia)", "SD"],
    "Zoran Jankovic's List -- Positive Slovenia": ["Positive Slovenia", "LZJ"],
    "Estonian Coalition Party": ["Estonian Coalition Party"],
    "Res Publica Party": ["Res Publica Party", "Pro Patria and Res Publica Union", "Isamaa"],
    "Social Democratic Party of Croatia": ["SDP"],
}

MANUAL = {
    "AT": [("2021-10-11", "Schallenberg", "Austrian People's Party", "ÖVP"),
           ("2021-12-06", "Nehammer", "Austrian People's Party", "ÖVP")],
    "BG": [("2021-05-12", "Yanev (caretaker)", None, None, True),
           ("2021-12-13", "Petkov", "We Continue the Change", "PP"),
           ("2022-08-02", "Donev (caretaker)", None, None, True),
           ("2023-06-06", "Denkov", "We Continue the Change", "PP"),
           ("2024-04-09", "Glavchev (caretaker)", None, None, True),
           ("2025-01-16", "Zhelyazkov", "GERB", "GERB"),
           ("2025-12-11", "Zhelyazkov (resigned, caretaker)", "GERB", "GERB", True)],
    "CZ": [("2021-12-17", "Fiala", "Civic Democratic Party (Czech Republic)", "ODS")],
    "DK": [("2022-12-15", "Frederiksen II", "Social Democrats (Denmark)", "A")],
    "EE": [("2021-01-26", "Kallas", "Estonian Reform Party", "Reform")],
    "FR": [("2020-07-03", "Castex", "La République En Marche!", "LREM"),
           ("2022-05-16", "Borne", "Ensemble (political coalition)", "ENS"),
           ("2024-01-09", "Attal", "Ensemble (political coalition)", "ENS")],
    "DE": [("2021-12-08", "Scholz", "Social Democratic Party of Germany", "SPD")],
    "GR": [("2023-05-24", "Sarmas (caretaker)", None, None, True)],
    "HU": [("2022-05-24", "Orbán V", "Fidesz–KDNP", "Fidesz")],
    "IE": [("2022-12-17", "Varadkar", "Fine Gael", "FG"),
           ("2024-04-09", "Harris", "Fine Gael", "FG")],
    "IS": [("2021-11-28", "Jakobsdóttir II", "Left-Green Movement", "V"),
           ("2024-04-09", "Benediktsson", "Independence Party (Iceland)", "D")],
    "IT": [("2021-02-13", "Draghi (non-party)", None, None)],
    "NL": [("2022-01-10", "Rutte IV", "People's Party for Freedom and Democracy", "VVD"),
           ("2024-07-02", "Schoof (non-party)", None, None)],
    "NO": [("2021-10-14", "Støre", "Labour Party (Norway)", "Ap")],
    "PT": [("2022-03-30", "Costa III", "Socialist Party (Portugal)", "PS"),
           ("2024-04-02", "Montenegro", "Democratic Alliance (Portugal, 2024)", "AD")],
    "RO": [("2021-11-25", "Ciucă", "National Liberal Party (Romania)", "PNL"),
           ("2023-06-15", "Ciolacu", "Social Democratic Party (Romania)", "PSD")],
    "SK": [("2021-04-01", "Heger", "Slovakia (political party)", "OĽaNO"),
           ("2023-05-15", "Ódor (non-party, caretaker)", None, None, True)],
    "SI": [("2022-06-01", "Golob", "Freedom Movement (Slovenia)", "GS")],
    "SE": [("2021-11-30", "Andersson", "Swedish Social Democratic Party", "S")],
    "GB": [("2022-09-06", "Truss", "Conservative Party (UK)", "Con"),
           ("2022-10-25", "Sunak", "Conservative Party (UK)", "Con")],
    "RS": [("2001-01-25", "Đinđić", "Democratic Party (Serbia)", "DS"),
           ("2003-03-18", "Živković", "Democratic Party (Serbia)", "DS"),
           ("2004-03-03", "Koštunica", "Democratic Party of Serbia", "DSS"),
           ("2008-07-07", "Cvetković", "Democratic Party (Serbia)", "DS"),
           ("2012-07-27", "Dačić", "Socialist Party of Serbia", "SPS"),
           ("2014-04-27", "Vučić", "Serbian Progressive Party", "SNS"),
           ("2017-06-29", "Brnabić", "Serbian Progressive Party", "SNS")],
    "MD": [("2001-04-19", "Tarlev", "Party of Communists of the Republic of Moldova", "PCRM"),
           ("2008-03-31", "Greceanîi", "Party of Communists of the Republic of Moldova", "PCRM"),
           ("2009-09-25", "Filat", "Liberal Democratic Party of Moldova", "PLDM"),
           ("2013-05-31", "Leancă", "Liberal Democratic Party of Moldova", "PLDM"),
           ("2015-02-18", "Gaburici", "Liberal Democratic Party of Moldova", "PLDM"),
           ("2015-07-30", "Streleț", "Liberal Democratic Party of Moldova", "PLDM"),
           ("2016-01-20", "Filip", "Democratic Party of Moldova", "PDM"),
           ("2019-06-08", "Sandu", "Party of Action and Solidarity", "PAS"),
           ("2019-11-14", "Chicu (non-party)", None, None),
           ("2020-12-31", "Ciocoi (acting)", None, None, True),
           ("2021-08-06", "Gavrilița", "Party of Action and Solidarity", "PAS"),
           ("2023-02-16", "Recean", "Party of Action and Solidarity", "PAS")],
    "ME": [("2003-01-08", "Đukanović", "Democratic Party of Socialists of Montenegro", "DPS"),
           ("2006-11-10", "Šturanović", "Democratic Party of Socialists of Montenegro", "DPS"),
           ("2008-02-29", "Đukanović", "Democratic Party of Socialists of Montenegro", "DPS"),
           ("2010-12-29", "Lukšić", "Democratic Party of Socialists of Montenegro", "DPS"),
           ("2012-12-04", "Đukanović", "Democratic Party of Socialists of Montenegro", "DPS"),
           ("2016-11-28", "Marković", "Democratic Party of Socialists of Montenegro", "DPS"),
           ("2020-12-04", "Krivokapić (non-party)", None, None),
           ("2022-04-28", "Abazović", "United Reform Action", "URA")],
}

# ParlGov codes the French PM's own party; the dashboard follows the PM's camp (as countries.yaml does)
CAMP = {("FR", "Philippe"): ("La République En Marche!", "LREM")}   # matched to Ensemble below


def leader_name(cab: str) -> str:
    return re.sub(r"\s+(?:[IVX]+|[A-Z])(?:\s+[IVX]+)?$", "", cab).strip()


def main():
    out: dict[str, list] = {}
    with open(ROOT / "data" / "external" / "parlgov_pm_cabinets.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            cc = ISO3[r["country_name_short"]]
            party = None if r["party_name_short"] in ("none", "PC") else r["party_name_english"]
            short = None if party is None else r["party_name_short"]
            lead = leader_name(r["cabinet_name"])
            if (cc, lead) in CAMP:
                party, short = CAMP[(cc, lead)]
            match = []
            if party:
                match = [p.strip() for p in party.split("|")] + EXTRA_MATCH.get(party, [])
                match += [s.strip() for s in (short or "").split("|")]
            out.setdefault(cc, []).append({
                "from": r["start_date"], "leader": lead, "party": party, "party_short": short,
                "caretaker": r["caretaker"] == "1", "match": match, "source": "ParlGov"})
    for cc, rows in MANUAL.items():
        for row in rows:
            d, lead, party, short = row[:4]
            care = row[4] if len(row) > 4 else False
            match = [x for x in (party, short) if x] + EXTRA_MATCH.get(party or "", [])
            out.setdefault(cc, []).append({"from": d, "leader": lead, "party": party, "party_short": short,
                                           "caretaker": care, "match": match, "source": "manual"})
    for cc in out:
        out[cc].sort(key=lambda g: g["from"])
    head = ("# GENERATED by tools/make_governments.py. Heads of government and their party since 1985.\n"
            "# ParlGov (parlgov.org) up to 2020, then hand-entered from Wikipedia. Periods covered by\n"
            "# `incumbents` in countries.yaml are taken from there instead.\n")
    path = ROOT / "config" / "governments.yaml"
    path.write_text(head + yaml.safe_dump({"countries": out}, allow_unicode=True, sort_keys=True, width=160),
                    encoding="utf-8")
    print(f"wrote {path}: {sum(len(v) for v in out.values())} periods, {len(out)} countries")


if __name__ == "__main__":
    main()
