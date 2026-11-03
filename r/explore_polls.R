# Explore the scraped polls in R ---------------------------------------------------------
# data/processed/polls_long.csv is tidy: one row per poll x party.
#   country, cycle, page, pollster, client, area, fieldwork_start, fieldwork_end,
#   sample_size, party, share_raw (as printed on Wikipedia), share (excl. undecided), undecided
library(tidyverse)

polls <- read_csv("data/processed/polls_long.csv", show_col_types = FALSE) |>
  mutate(mid = fieldwork_start + (fieldwork_end - fieldwork_start) / 2)

# Example: Poland, current term, LOESS through the polls
pl <- polls |>
  filter(country == "PL") |>
  group_by(party) |> filter(max(share) >= 3) |> ungroup()

ggplot(pl, aes(mid, share, colour = party)) +
  geom_point(alpha = 0.25, size = 0.8) +
  geom_smooth(method = "loess", span = 0.25, se = FALSE, linewidth = 1) +
  labs(x = NULL, y = "Vote intention (%)", colour = NULL,
       title = "Poland: polls since the 2023 election",
       caption = "Source: Wikipedia opinion-polling pages (CC BY-SA 4.0)") +
  theme_minimal()

# The dashboard's own trend lines (local linear regression) are in site/data/europe.json:
# jsonlite::fromJSON("site/data/europe.json")$countries
