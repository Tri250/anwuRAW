const fs=require("fs");
const {Document,Packer,Paragraph,TextRun,ImageRun}=require("docx");
const img=fs.readFileSync("unpacked/word/media/image1.png");
const doc=new Document({sections:[{children:[
 new Paragraph({children:[new ImageRun({type:"png",data:img,transformation:{width:96,height:134},altText:{title:"t",description:"d",name:"n"}})]}),
 new Paragraph({spacing:{line:240},children:[new TextRun("测试 line240")]}),
]}]});
Packer.toBuffer(doc).then(b=>fs.writeFileSync("testimg.docx",b));
