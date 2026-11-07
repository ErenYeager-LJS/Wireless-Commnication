// 参数化中继节点外壳。双天线孔和散热槽，打印前必须复核实物。
$fn = 48;
board = [92, 62, 24];
wall = 2.6;
clearance = 1.5;
outer = [board.x + 2*(wall+clearance), board.y + 2*(wall+clearance), board.z + wall + 5];

difference() {
  cube(outer, center=true);
  translate([0,0,wall]) cube([outer.x-2*wall,outer.y-2*wall,outer.z],center=true);
  for(y=[-20,20]) translate([outer.x/2,y,4]) rotate([0,90,0]) cylinder(h=wall*3,d=7,center=true); // 天线
  translate([-outer.x/2,0,-4]) cube([wall*3,16,9],center=true); // USB/网口
  for(x=[-32:-8:32]) translate([x,outer.y/2,5]) rotate([90,0,0]) cube([4,12,wall*3],center=true);
}
