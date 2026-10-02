import io
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
from build_graph import CAR_HIGHWAYS, FLAG_ONEWAY, FLAG_ONEWAY_REVERSE, FLAG_ROUNDABOUT, build, parse_osm  # noqa: E402

OSM = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <node id="1" lat="50.0000" lon="30.0000"/>
  <node id="2" lat="50.0000" lon="30.0010"/>
  <node id="3" lat="50.0000" lon="30.0020"/>
  <node id="4" lat="50.0010" lon="30.0010"/>
  <node id="5" lat="49.9990" lon="30.0010"/>
  <node id="6" lat="50.0000" lon="30.00150"/>
  <node id="9" lat="51.0000" lon="31.0000"/>
  <node id="10" lat="51.0000" lon="31.0010"/>
  <way id="100"><nd ref="1"/><nd ref="2"/><nd ref="6"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="name" v="Shevchenko St"/><tag k="name:uk" v="вулиця Шевченка"/></way>
  <way id="101"><nd ref="4"/><nd ref="2"/><nd ref="5"/>
    <tag k="highway" v="primary"/><tag k="name" v="проспект Перемоги"/><tag k="oneway" v="-1"/></way>
  <way id="102"><nd ref="1"/><nd ref="4"/>
    <tag k="highway" v="tertiary"/><tag k="junction" v="roundabout"/></way>
  <way id="103"><nd ref="1"/><nd ref="5"/>
    <tag k="highway" v="residential"/><tag k="access" v="private"/></way>
  <way id="104"><nd ref="9"/><nd ref="10"/><tag k="highway" v="residential"/></way>
  <way id="105"><nd ref="3"/><nd ref="5"/><tag k="highway" v="footway"/></way>
</osm>"""


class BuildGraphTest(unittest.TestCase):
    def setUp(self):
        coords, ways = parse_osm(io.BytesIO(OSM.encode()), set(CAR_HIGHWAYS))
        self.graph = build(coords, ways, 'Тест')

    def test_filters_and_flags(self):
        g = self.graph
        self.assertEqual(len(g['ways']), 3)  # приватна, пішохідна та ізольована дороги відкинуті
        by_name = {g['names'][w[0]] if w[0] >= 0 else '': w for w in g['ways']}
        self.assertIn('вулиця Шевченка', by_name)  # name:uk має пріоритет
        self.assertEqual(by_name['проспект Перемоги'][2], FLAG_ONEWAY_REVERSE)
        self.assertEqual(by_name[''][2], FLAG_ONEWAY | FLAG_ROUNDABOUT)

    def test_simplification_keeps_junctions(self):
        g = self.graph
        shev = next(w for w in g['ways'] if w[0] >= 0 and g['names'][w[0]] == 'вулиця Шевченка')
        # проміжна колінеарна точка (id 6) прибрана, а перехрестя (id 2) залишилося
        self.assertEqual(len(shev) - 3, 3)
        self.assertEqual(len(g['nodes']) // 2, 5)


if __name__ == '__main__':
    unittest.main()
