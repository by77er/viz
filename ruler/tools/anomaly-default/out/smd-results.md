### SMD (889 series on 28 machines; 2189 windows from 2329 labelled segments; frozen 2026-11-19T02:27:28.097Z, fetched 2026-11-19T02:28:39Z)

| detector | SMD standard | SMD low FP | SMD low FN | NAB held-out (std / low FP / low FN) | rank (std) | vs EWMA, std [95%] | vs threshold, std [95%] |
|---|---|---|---|---|---|---|---|
| threshold | 16.4 | 15.5 | 19.6 | 21.8 / 5.5 / 32.7 | 3 | +6.0 [-10.4, 31.1] | – |
| ewma | 10.4 | -38.4 | 8.3 | 30.1 / 3.9 / 40.8 | 4 | – | -6.0 [-30.9, 10.5] |
| robust_z | -318.2 | -698.7 | -190.4 | -105.9 / -282.4 / -45.6 | 9 | -328.6 [-518.3, -191.7] | -334.6 [-542.2, -183.9] |
| seasonal | -382.8 | -842.2 | -228.6 | -76.4 / -223.3 / -26.2 | 10 | -393.2 [-583.7, -251.8] | -399.2 [-609.9, -245.0] |
| stl | -1065.0 | -2207.2 | -683.4 | -352.2 / -795.4 / -203.5 | 12 | -1075.4 [-1497.6, -729.7] | -1081.4 [-1524.6, -719.4] |
| cusum | -147.6 | -374.2 | -71.1 | 15.1 / -51.2 / 38.8 | 8 | -158.0 [-249.7, -91.3] | -164.0 [-265.2, -87.9] |
| pelt | -627.4 | -1338.5 | -389.3 | -123.5 / -321.3 / -55.9 | 11 | -637.8 [-885.8, -438.3] | -643.8 [-914.8, -430.7] |
| robust_z_posthoc | -78.7 | -199.3 | -74.2 | -5.1 / -40.7 / -4.7 | 6 | -89.1 [-154.2, -42.5] | -95.1 [-176.7, -39.2] |
| seasonal_posthoc | -145.8 | -203.9 | -78.2 | 4.7 / -26.6 / 22.1 | 7 | -156.2 [-253.2, -85.7] | -162.2 [-279.2, -78.1] |
| robust_z_quantile | 42.8 | 23.0 | 44.0 | 44.8 / 33.7 / 52.3 | 1 | +32.4 [20.7, 48.7] | +26.3 [15.6, 35.0] |
| seasonal_quantile | 35.5 | 21.0 | 48.6 | 41.4 / 18.8 / 48.1 | 2 | +25.1 [15.9, 37.6] | +19.1 [4.0, 29.9] |
| random | -68.0 | -1.5 | -18.8 | 16.1 / 5.9 / 26.5 | 5 | -78.4 [-101.4, -59.0] | -84.5 [-120.6, -55.7] |
| robust_z_quantile window 1000 (post hoc) | 37.6 | 9.9 | 48.0 | – | post hoc | +27.2 [17.2, 41.0] | +21.1 [7.7, 31.3] |
| robust_z_quantile window 288 (post hoc) | 28.6 | -16.4 | 44.9 | – | post hoc | +18.2 [10.1, 29.1] | +12.2 [-5.6, 25.5] |
| robust_z_quantile window 1500 (post hoc) | 42.5 | 21.2 | 50.8 | – | post hoc | +32.0 [20.6, 48.1] | +26.0 [14.6, 35.1] |

| detector | config (standard) | window recall | event precision (NAB windows) | event P / R / F1 (±15 min) | F1 vs EWMA [95%] | median delay (min) | machine view P / R / F1 | false onsets per machine-day | low-FP config: machine P / R, false per machine-day |
|---|---|---|---|---|---|---|---|---|---|
| threshold | threshold(m=0.5) | 26% | 57% | 45% / 26% / 0.328 | +0.122 [0.022, 0.213] | 10 | 46% / 33% / 0.384 | 1.5 | 76% / 27%, 0.5 |
| ewma | ewma(halfLifePoints=100,k=8) | 62% | 20% | 12% / 58% / 0.206 | – | 2 | 12% / 98% / 0.214 | 29.5 | 12% / 98%, 29.5 |
| robust_z | robust_z(windowPoints=1000,k=10) | 65% | 11% | 5% / 62% / 0.087 | -0.118 [-0.152, -0.084] | 1 | 6% / 94% / 0.109 | 119.3 | 6% / 94%, 119.3 |
| seasonal | seasonal(seasons=1,k=9,adapt=robust) | 80% | 12% | 5% / 76% / 0.097 | -0.108 [-0.145, -0.074] | 2 | 6% / 92% / 0.106 | 140.5 | 6% / 92%, 140.5 |
| stl | stl(k=9) | 80% | 11% | 3% / 75% / 0.066 | -0.140 [-0.180, -0.105] | 0 | 3% / 65% / 0.064 | 119.4 | 3% / 65%, 119.4 |
| cusum | cusum(k=1,h=20) | 82% | 12% | 4% / 71% / 0.073 | -0.132 [-0.178, -0.092] | 5 | 7% / 100% / 0.123 | 124.8 | 7% / 100%, 124.8 |
| pelt | pelt(minShift=8) | 87% | 11% | 3% / 84% / 0.067 | -0.139 [-0.180, -0.105] | 7 | 5% / 100% / 0.104 | 112.7 | 5% / 100%, 112.7 |
| robust_z_posthoc | robust_z_posthoc(windowPoints=1000,k=40) | 44% | 14% | 7% / 42% / 0.113 | -0.092 [-0.132, -0.044] | 3 | 7% / 94% / 0.130 | 67.9 | 7% / 94%, 67.9 |
| seasonal_posthoc | seasonal_posthoc(seasons=3,k=25,adapt=robust) | 57% | 13% | 7% / 54% / 0.117 | -0.088 [-0.127, -0.039] | 3 | 7% / 96% / 0.124 | 91.7 | 7% / 96%, 66.0 |
| robust_z_quantile | robust_z_quantile(windowPoints=4000,k=2,spread=quantile) | 66% | 41% | 34% / 62% / 0.441 | +0.235 [0.202, 0.266] | 3 | 21% / 98% / 0.345 | 11.5 | 21% / 98%, 11.5 |
| seasonal_quantile | seasonal_quantile(seasons=1,k=2,adapt=robust,spread=quantile) | 75% | 28% | 22% / 69% / 0.330 | +0.125 [0.086, 0.161] | 3 | 14% / 98% / 0.251 | 19.7 | 17% / 94%, 11.5 |
| random | random(p=0.003) | 80% | 10% | 2% / 29% / 0.034 | -0.172 [-0.219, -0.133] | 43 | 6% / 98% / 0.105 | 112.7 | 6% / 24%, 4.3 |
| robust_z_quantile window 1000 (post hoc) | robust_z_quantile(windowPoints=1000,k=2,spread=quantile) | 69% | 29% | 22% / 64% / 0.331 | +0.126 [0.104, 0.146] | 2 | 17% / 99% / 0.286 | 15.3 | 17% / 99%, 15.3 |
| robust_z_quantile window 288 (post hoc) | robust_z_quantile(windowPoints=288,k=2,spread=quantile) | 77% | 20% | 12% / 71% / 0.211 | +0.006 [-0.019, 0.028] | 2 | 11% / 99% / 0.201 | 22.9 | 11% / 99%, 22.9 |
| robust_z_quantile window 1500 (post hoc) | robust_z_quantile(windowPoints=1500,k=2,spread=quantile) | 67% | 34% | 28% / 63% / 0.382 | +0.177 [0.151, 0.202] | 3 | 19% / 99% / 0.312 | 12.2 | 19% / 99%, 12.2 |

| detector | low FP vs EWMA [95%] | low FP vs threshold [95%] | strict (no don't-care) std / low FP / low FN | CPU ms per 1,000 points |
|---|---|---|---|---|
| threshold | +53.9 [21.9, 100.9] | – | 15.9 / 15.1 / 19.2 | 0.16 |
| ewma | – | -53.9 [-100.8, -21.9] | 6.3 / -46.7 / 3.9 | 0.33 |
| robust_z | -660.2 [-1040.6, -386.2] | -714.2 [-1133.2, -408.8] | -335.8 / -733.9 / -202.2 | 4.82 |
| seasonal | -803.8 [-1188.2, -518.1] | -857.7 [-1291.8, -543.6] | -404.2 / -885.1 / -242.9 | 37.78 |
| stl | -2168.7 [-3015.4, -1478.4] | -2222.7 [-3108.4, -1500.8] | -1115.7 / -2308.5 / -717.2 | 36.93 |
| cusum | -335.8 [-520.5, -202.7] | -389.7 [-598.7, -238.1] | -156.1 / -391.2 / -76.7 | 0.32 |
| pelt | -1300.0 [-1798.8, -899.2] | -1354.0 [-1894.9, -923.7] | -655.7 / -1395.2 / -408.2 | 57.82 |
| robust_z_posthoc | -160.8 [-293.0, -65.0] | -214.8 [-381.4, -100.3] | -84.0 / -210.0 / -78.5 | 4.82 |
| seasonal_posthoc | -165.4 [-287.5, -77.5] | -219.4 [-377.4, -110.2] | -154.7 / -215.3 / -84.1 | 30.61 |
| robust_z_quantile | +61.5 [38.5, 93.6] | +7.5 [-8.8, 19.7] | 39.5 / 16.4 / 40.3 | 7.94 |
| seasonal_quantile | +59.5 [36.0, 93.2] | +5.5 [-11.7, 18.5] | 31.6 / 16.7 / 46.0 | 50.21 |
| random | +36.9 [7.9, 79.9] | -17.0 [-25.7, -9.2] | -73.7 / -1.9 / -22.6 | – |
| robust_z_quantile window 1000 (post hoc) | +48.3 [28.6, 75.6] | -5.7 [-27.9, 10.7] | 34.1 / 3.0 / 45.7 | 1.90 |
| robust_z_quantile window 288 (post hoc) | +22.1 [5.8, 44.6] | -31.9 [-65.5, -6.8] | 24.9 / -23.8 / 42.4 | 0.69 |
| robust_z_quantile window 1500 (post hoc) | +59.6 [37.4, 90.5] | +5.7 [-12.4, 19.0] | 39.2 / 14.8 / 48.6 | 2.72 |

| hypothesis (from NAB) | held on SMD | numbers |
|---|---|---|
| H1: robust_z_quantile > ewma (standard) | yes | 42.8 vs 10.4 |
| H2: seasonal_quantile > ewma (standard) | yes | 35.5 vs 10.4 |
| H3: ewma > threshold (standard) | **no** | 10.4 vs 16.4 |
| H4: threshold > ewma (reward_low_FP_rate) | yes | 15.5 vs -38.4 |
| H5: robust_z (MAD) < threshold and seasonal (MAD) < threshold (standard) | yes | -318.2, -382.8 vs 16.4 |
| H6: cusum, stl and pelt < threshold (standard) | yes | -147.6, -1065.0, -627.4 vs 16.4 |
| H7: robust_z_quantile > robust_z_posthoc (MAD with k up to 40): the spread, not only a larger k (standard) | yes | 42.8 vs -78.7 |
| H8: threshold > random (standard) | yes | 16.4 vs -68.0 |

- **robust_z_quantile: GENERALISES** (score 42.8 vs EWMA 10.4 and threshold 16.4; event F1 0.441 vs EWMA 0.206; score − EWMA 32.4, 95% interval [20.7, 48.7])
- **seasonal_quantile: GENERALISES** (score 35.5 vs EWMA 10.4 and threshold 16.4; event F1 0.330 vs EWMA 0.206; score − EWMA 25.1, 95% interval [15.9, 37.6])

Interpretation ranges: 0-based, end exclusive (disagrees with test_label on 52 of 708420 rows; next best 373). Seasonality detected on the history: 168 h 84, 24 h 394, none 377, 1 h 34. Constant series excluded: 175.
