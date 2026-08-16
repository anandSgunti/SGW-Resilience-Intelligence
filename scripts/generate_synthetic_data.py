from pathlib import Path
from sgw_platform.synthetic import write_synthetic_data

if __name__ == "__main__":
    target = Path(__file__).parents[1] / "data" / "synthetic_sgw.json"
    print(write_synthetic_data(target))

