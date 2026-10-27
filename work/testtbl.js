const fs=require("fs");
const {Document,Packer,Paragraph,TextRun,ImageRun,Table,TableRow,TableCell,WidthType,BorderStyle,VerticalAlign}=require("docx");
const img=fs.readFileSync("unpacked/word/media/image1.png");
const nb={style:BorderStyle.NONE,size:0,color:"FFFFFF"};
const cell=(w,ch)=>new TableCell({width:{size:w,type:WidthType.DXA},margins:{top:0,bottom:0,left:0,right:0},verticalAlign:VerticalAlign.CENTER,children:ch});
const doc=new Document({sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:720,right:900,bottom:560,left:900}}},children:[
 new Table({width:{size:10106,type:WidthType.DXA},columnWidths:[8006,2100],borders:{top:nb,bottom:nb,left:nb,right:nb,insideHorizontal:nb,insideVertical:nb},rows:[
  new TableRow({cantSplit:true,children:[
   cell(8006,[new Paragraph("覃日丽")]),
   cell(2100,[new Paragraph({alignment:"right",spacing:{line:240},children:[new ImageRun({type:"png",data:img,transformation:{width:96,height:134},altText:{title:"t",description:"d",name:"n"}})]})])
  ]})
 ]})
]}]});
Packer.toBuffer(doc).then(b=>fs.writeFileSync("testtbl.docx",b));
