import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from openpyxl import load_workbook

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('legacy_kalshi',ROOT/'__init__.py',submodule_search_locations=[str(ROOT)])
package=importlib.util.module_from_spec(spec);sys.modules[spec.name]=package;spec.loader.exec_module(package)
from legacy_kalshi.pipeline import EquityResearchPipeline


class ScaffoldTests(unittest.TestCase):
    def test_synthetic_export_is_runnable_and_has_both_exhibits(self):
        with tempfile.TemporaryDirectory() as folder:
            result=EquityResearchPipeline(output_dir=folder,use_live_api=False).run()
            book=load_workbook(result['excel_path'],read_only=True)
            self.assertEqual(book.sheetnames,['High_Freq_Market_Monitor','OSB_GGR_EBITDA_Sensitivity'])
            self.assertGreater(book.worksheets[0].max_row,1)
            self.assertEqual(book.worksheets[1].max_row,26)
            book.close()
            self.assertTrue(Path(result['csv_path']).exists())
