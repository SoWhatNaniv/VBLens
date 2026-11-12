import sys, pefile, capstone
pe=pefile.PE(sys.argv[1]); IB=pe.OPTIONAL_HEADER.ImageBase
s=pe.sections[0]
data=s.get_data()[:s.Misc_VirtualSize]
va=IB+s.VirtualAddress
md=capstone.Cs(capstone.CS_ARCH_X86,capstone.CS_MODE_32)
md.skipdata=True
with open(sys.argv[2],'w') as f:
  for i in md.disasm_lite(data,va):
    f.write('%x\t%d\t%s\t%s\n'%(i[0],i[1],i[2],i[3]))
